import { collection, addDoc, serverTimestamp, getDocFromServer, doc, onSnapshot, updateDoc, increment, setDoc, getDoc, query, where, getDocs, limit } from 'firebase/firestore';
import { db, auth } from '../firebase';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test connection on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log('Firestore connection test successful');
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration. The client is offline.");
    }
    // Skip logging for other errors, as this is simply a connection test.
  }
}
testConnection();

// Generate a random session ID for the visit
const SESSION_ID = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

const getDeviceType = () => {
  const ua = navigator.userAgent;
  if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) return "Tablet";
  if (/Mobile|iP(hone|od)|Android|BlackBerry|IEMobile|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) return "Mobile";
  return "Desktop";
};

export interface TrackingProperties {
  [key: string]: any;
}

export const getUTMParams = () => {
  const params = new URLSearchParams(window.location.search);
  const utms: Record<string, string> = {};
  
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(key => {
    const val = params.get(key);
    if (val) utms[key] = val;
  });
  
  return utms;
};

const cleanData = (data: any): any => {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(cleanData);
  if (data instanceof Date) return data;
  
  // Check if it's a Firestore FieldValue or similar special object
  // These usually don't have a standard constructor or have specific internal properties
  if (data.constructor?.name === 'FieldValue' || data._methodName) return data;

  const cleaned: any = {};
  Object.keys(data).forEach(key => {
    const value = data[key];
    if (value !== undefined) {
      cleaned[key] = cleanData(value);
    }
  });
  return cleaned;
};

export const trackEvent = async (eventName: string, properties: TrackingProperties = {}) => {
  const url = 'https://ais-dev-ntazh4dq53lpfbniqopixv-81264801679.europe-west3.run.app/api/track';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      mode: 'cors',
      body: JSON.stringify({
        event_name: eventName,
        timestamp: new Date().toISOString(),
        session_id: localStorage.getItem('bidflow_session') || 
                   (s => (localStorage.setItem('bidflow_session', s), s))('s_' + Math.random().toString(36).substr(2, 9)),
        properties: {
          ...properties,
          url: window.location.href,
          referrer: document.referrer,
          screen: window.innerWidth + 'x' + window.innerHeight,
          device: getDeviceType(),
          language: navigator.language || 'en',
        }
      })
    });
    const result = await response.json();
    console.log(`Event tracked via API: ${eventName}`, result);
  } catch (error) {
    console.error(`Track error for ${eventName}:`, error);
  }
};

// Scroll Depth Tracking
let maxScroll = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => {
    const scrollPercent = Math.round((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100);
    if (scrollPercent > maxScroll) {
      maxScroll = scrollPercent;
      if (maxScroll % 25 === 0) {
        trackEvent('scroll_depth', { depth: maxScroll });
      }
    }
  });

  // Session Duration Tracking
  const startTime = Date.now();
  window.addEventListener('beforeunload', () => {
    const duration = Math.round((Date.now() - startTime) / 1000);
    trackEvent('session_end', { duration: duration, max_scroll: maxScroll });
  });
}

export const saveUserRegistration = async (userData: any) => {
  try {
    // Check if email already exists
    const q = query(collection(db, 'users'), where('email', '==', userData.email), limit(1));
    const querySnapshot = await getDocs(q);
    
    if (!querySnapshot.empty) {
      console.log('User with this email already exists');
      return { success: false, alreadyExists: true };
    }

    const utms = getUTMParams();
    const data = cleanData({
      ...userData,
      timestamp: new Date().toISOString(),
      firestore_timestamp: serverTimestamp(),
      session_id: SESSION_ID,
      utm_source: utms.utm_source,
      utm_campaign: utms.utm_campaign,
    });

    await addDoc(collection(db, 'users'), data);
    
    // Update public counters
    const counterRef = doc(db, 'stats', 'counters');
    const roleKey = userData.role === 'buyer' ? 'buyers' : 'suppliers';
    
    try {
      await updateDoc(counterRef, {
        [roleKey]: increment(1)
      });
    } catch (e) {
      // If document doesn't exist, try to create it (might fail due to rules if not admin, 
      // but rules allow update if it exists)
      console.warn('Counter update failed, document might not exist yet');
    }

    console.log('User registration saved:', data);
    return { success: true };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'users');
    return { success: false, error };
  }
};

export const subscribeToCounters = (callback: (data: { buyers: number; suppliers: number }) => void) => {
  const counterRef = doc(db, 'stats', 'counters');
  return onSnapshot(counterRef, (snapshot) => {
    if (snapshot.exists()) {
      callback(snapshot.data() as { buyers: number; suppliers: number });
    }
  }, (error) => {
    handleFirestoreError(error, OperationType.LIST, 'stats/counters');
  });
};

export const initializeCounters = async () => {
  try {
    const counterRef = doc(db, 'stats', 'counters');
    const snap = await getDoc(counterRef);
    
    // Only reset if the document doesn't exist OR it still has the old default values (142+38=180)
    if (!snap.exists() || (snap.data()?.buyers === 142 && snap.data()?.suppliers === 38)) {
      await setDoc(counterRef, {
        buyers: 0,
        suppliers: 0
      });
      console.log('Counters initialized/reset to 0');
    }
  } catch (error) {
    console.error('Failed to initialize counters:', error);
  }
};

import { collection, addDoc, serverTimestamp, getDocFromServer, doc, onSnapshot, updateDoc, increment, setDoc, getDoc } from 'firebase/firestore';
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
  try {
    const utms = getUTMParams();
    const eventData = cleanData({
      event_name: eventName,
      timestamp: new Date().toISOString(),
      firestore_timestamp: serverTimestamp(),
      session_id: SESSION_ID,
      properties: {
        device: getDeviceType(),
        language: navigator.language || 'en',
        ...properties,
        ...utms,
        url: window.location.href,
        referrer: document.referrer,
      },
    });

    await addDoc(collection(db, 'events'), eventData);
    console.log(`Event tracked: ${eventName}`, eventData);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'events');
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
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'users');
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
    if (!snap.exists()) {
      await setDoc(counterRef, {
        buyers: 142,
        suppliers: 38
      });
      console.log('Counters initialized');
    }
  } catch (error) {
    console.error('Failed to initialize counters:', error);
  }
};

import { 
  getFirestore, 
  collection, 
  addDoc, 
  serverTimestamp, 
  doc, 
  onSnapshot, 
  updateDoc, 
  increment, 
  setDoc, 
  getDoc, 
  getDocFromServer,
  query, 
  where, 
  getDocs, 
  limit,
  getCountFromServer
} from 'firebase/firestore';
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

const generateCode = () => Math.floor(1000 + Math.random() * 9000).toString();

const isCodeUnique = async (code: string) => {
  const usersRef = collection(db, 'users');
  const q = query(usersRef, where('code', '==', code));
  const snap = await getDocs(q);
  return snap.empty;
};

const getUniqueCode = async (): Promise<string> => {
  let code = generateCode();
  let attempts = 0;
  while (!(await isCodeUnique(code)) && attempts < 10) {
    code = generateCode();
    attempts++;
  }
  return code;
};

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
  // If the global tracking script is available, use it for consistency (handles UTMs, sessions, etc.)
  if (window.bidflow && typeof window.bidflow.track === 'function') {
    window.bidflow.track(eventName, properties);
    return;
  }

  const url = 'https://ais-pre-ntazh4dq53lpfbniqopixv-81264801679.europe-west3.run.app/api/track';
  const payload = JSON.stringify({
    event_name: eventName,
    timestamp: new Date().toISOString(),
    session_id: sessionStorage.getItem('bf_sid') || 
               (s => (sessionStorage.setItem('bf_sid', s), s))('s_' + Math.random().toString(36).substr(2, 9)),
    properties: {
      ...properties,
      url: window.location.href,
      referrer: document.referrer,
      ua: navigator.userAgent,
      device: getDeviceType(),
      language: navigator.language || 'en',
    }
  });

  // Try sendBeacon
  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: 'application/json' });
    if (navigator.sendBeacon(url, blob)) {
      return;
    }
  }

  // Fallback to fetch
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      mode: 'cors',
      credentials: 'omit',
      body: payload
    });
    
    if (response.ok) {
      console.log('BidFlow Success (Service)');
    }
  } catch (error) {
    if (error instanceof Error) {
      console.warn('BidFlow Tracking Error:', error.message);
    }
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
    const email = userData.email.toLowerCase();
    const userRef = doc(db, 'users', email);
    
    // Check if user already exists using the email as ID
    const userDoc = await getDoc(userRef);
    if (userDoc.exists()) {
      console.log('User with this email already exists');
      return { success: false, alreadyExists: true };
    }

    // Generate unique 4-digit code
    const uniqueCode = await getUniqueCode();

    const utms = getUTMParams();
    const data = cleanData({
      ...userData,
      email: email, 
      code: uniqueCode,
      timestamp: new Date().toISOString(),
      firestore_timestamp: serverTimestamp(),
      session_id: SESSION_ID,
      utm_source: utms.utm_source,
      utm_campaign: utms.utm_campaign,
    });

    await setDoc(userRef, data);
    
    // Update public counters
    const counterRef = doc(db, 'stats', 'counters');
    const roleKey = userData.role === 'buyer' ? 'buyers' : 'suppliers';
    
    try {
      await updateDoc(counterRef, {
        [roleKey]: increment(1)
      });
    } catch (e) {
      // If document doesn't exist, create it with 1
      await setDoc(counterRef, {
        buyers: userData.role === 'buyer' ? 1 : 0,
        suppliers: userData.role === 'supplier' ? 1 : 0
      }, { merge: true });
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
    
    // Use Aggregation Queries (very cheap: 1 read per 1000 documents)
    // to get the absolute source of truth from the users collection
    const buyersQuery = query(collection(db, 'users'), where('role', '==', 'buyer'));
    const suppliersQuery = query(collection(db, 'users'), where('role', '==', 'supplier'));
    
    const [buyersSnap, suppliersSnap] = await Promise.all([
      getCountFromServer(buyersQuery),
      getCountFromServer(suppliersQuery)
    ]);
    
    const actualBuyers = buyersSnap.data().count;
    const actualSuppliers = suppliersSnap.data().count;

    // Check last sync to avoid overwriting too frequently if needed, 
    // but for now, we sync on every app load to ensure accuracy.
    await setDoc(counterRef, {
      buyers: actualBuyers,
      suppliers: actualSuppliers,
      lastReconciled: serverTimestamp()
    }, { merge: true });
    
    console.log(`Counters reconciled: Buyers=${actualBuyers}, Suppliers=${actualSuppliers}`);
  } catch (error) {
    console.error('Failed to reconcile counters:', error);
  }
};

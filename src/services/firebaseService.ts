import { initializeApp } from 'firebase/app';
import { 
  initializeFirestore, 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  limit, 
  deleteDoc, 
  Timestamp as ClientTimestamp, 
  getDocFromServer
} from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { pino } from 'pino';
import admin from 'firebase-admin';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

// Initialize client SDK
const app = initializeApp(firebaseConfig);
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, firebaseConfig.firestoreDatabaseId);

export let isUsingAdmin = false;
export let adminDb: any = null;

// Try to initialize Firebase Admin SDK using Service Account
const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccountEnv && !serviceAccountEnv.includes('...')) {
  try {
    let serviceAccount;
    if (serviceAccountEnv.trim().startsWith('{')) {
      serviceAccount = JSON.parse(serviceAccountEnv);
    } else {
      serviceAccount = JSON.parse(Buffer.from(serviceAccountEnv, 'base64').toString('utf8'));
    }

    const adminApp = admin.apps.length === 0 
      ? admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
      : admin.apps[0];
    
    const dbId = firebaseConfig.firestoreDatabaseId;
    adminDb = dbId ? getAdminFirestore(adminApp, dbId) : getAdminFirestore(adminApp);
    isUsingAdmin = true;
    logger.info('🛡️ Firebase Admin SDK initialized successfully using Service Account.');
  } catch (err) {
    logger.error({ err }, '⚠️ Failed to initialize Firebase Admin SDK. Falling back to Client SDK...');
  }
}

// Client SDK Auth cache
let isClientAuthenticated = false;

export async function authenticateClient() {
  if (isUsingAdmin || isClientAuthenticated) return true;
  
  const email = process.env.FIREBASE_ADMIN_EMAIL || 'ellisdagbui1@gmail.com';
  const password = process.env.FIREBASE_ADMIN_PASSWORD;
  
  if (!password) {
    logger.warn('⚠️ FIRESTORE SYNC ATTENTION REQUIRED:');
    logger.warn('To authenticate writing to Firebase from Render, please configure one of the following Environment Variables in your Render Dashboard:');
    logger.warn('1. FIREBASE_SERVICE_ACCOUNT: Copy the entire content of the Service Account key JSON file from Firebase Console -> Project Settings -> Service Accounts -> Generate new private key.');
    logger.warn('   (OR)');
    logger.warn('2. FIREBASE_ADMIN_PASSWORD: Set a password and enable "Email/Password" Auth in the Firebase Console under authentication, then create a user for ellisdagbui1@gmail.com.');
    logger.warn('');
    return false;
  }
  
  try {
    const auth = getAuth(app);
    await signInWithEmailAndPassword(auth, email, password);
    isClientAuthenticated = true;
    logger.info(`✅ Firebase Client SDK authenticated successfully as user: ${email}`);
    return true;
  } catch (err) {
    logger.error({ err }, `❌ Firebase Client SDK failed to authenticate as user: ${email}`);
    return false;
  }
}

// Test connection
export async function testFirebaseConnection() {
  try {
    if (isUsingAdmin) {
      await adminDb.collection('system').doc('ping').get();
    } else {
      await authenticateClient();
      await getDocFromServer(doc(db, 'system', 'ping'));
    }
    logger.info('🚀 Firebase connection established.');
    return true;
  } catch (error) {
    logger.error({ err: error }, '❌ Firebase connection failed');
    return false;
  }
}

// File Operations
export async function fsAddFile(data: any) {
  await authenticateClient();
  const fileId = data.file_id;
  
  if (isUsingAdmin) {
    const timestamp = data.added_at 
      ? admin.firestore.Timestamp.fromDate(new Date(data.added_at)) 
      : admin.firestore.Timestamp.now();
    await adminDb.collection('files').doc(fileId).set({
      ...data,
      added_at: timestamp
    });
  } else {
    const docRef = doc(db, 'files', fileId);
    await setDoc(docRef, {
      ...data,
      added_at: data.added_at ? ClientTimestamp.fromDate(new Date(data.added_at)) : ClientTimestamp.now()
    });
  }
}

export async function fsGetFiles() {
  await authenticateClient();
  
  if (isUsingAdmin) {
    const snapshot = await adminDb.collection('files')
      .orderBy('added_at', 'desc')
      .limit(100)
      .get();
    return snapshot.docs.map((d: any) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        added_at: data.added_at instanceof admin.firestore.Timestamp 
          ? data.added_at.toDate().toISOString() 
          : data.added_at
      };
    });
  } else {
    const q = query(collection(db, 'files'), orderBy('added_at', 'desc'), limit(100));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        added_at: data.added_at instanceof ClientTimestamp 
          ? data.added_at.toDate().toISOString() 
          : data.added_at
      };
    });
  }
}

// Stats Mapping
export async function fsGetStats() {
  await authenticateClient();
  
  if (isUsingAdmin) {
    const statsDoc = await adminDb.collection('config').doc('stats').get();
    if (statsDoc.exists) {
      return statsDoc.data();
    }
  } else {
    const statsRef = doc(db, 'config', 'stats');
    const statsDoc = await getDoc(statsRef);
    if (statsDoc.exists()) {
      return statsDoc.data();
    }
  }
  return null;
}

// Sync helper (to move local sqlite to firebase)
export async function syncSqliteToFirestore(localDb: any) {
  logger.info('Starting sync from SQLite to Firestore...');
  await authenticateClient();
  
  const files = localDb.prepare("SELECT * FROM files").all();
  
  let count = 0;
  for (const file of files) {
    await fsAddFile(file);
    count++;
    if (count % 50 === 0) logger.info(`Synced ${count} files...`);
  }
  
  // Announcements
  const announcements = localDb.prepare("SELECT * FROM announcements").all();
  for (const ann of announcements) {
    const annId = `${ann.title}_${ann.category}`.replace(/\//g, '_');
    
    if (isUsingAdmin) {
      await adminDb.collection('announcements').doc(annId).set({
        ...ann,
        created_at: admin.firestore.Timestamp.fromDate(new Date(ann.created_at))
      });
    } else {
      await setDoc(doc(db, 'announcements', annId), {
        ...ann,
        created_at: ClientTimestamp.fromDate(new Date(ann.created_at))
      });
    }
  }

  logger.info(`Sync complete. ${count} files moved to cloud.`);
}

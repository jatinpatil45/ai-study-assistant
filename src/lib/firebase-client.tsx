import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  updateProfile,
  type Auth,
  type User,
} from "firebase/auth";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const firebaseConfig = {
  apiKey:
    (import.meta.env["VITE_FIREBASE_API_KEY"] as string | undefined) ??
    "AIzaSyDtJTeXO2T3Lpx6Ic4GZRfI8xdQEYXdFPk",
  authDomain:
    (import.meta.env["VITE_FIREBASE_AUTH_DOMAIN"] as string | undefined) ??
    "ai-saas-jatin.firebaseapp.com",
  projectId: (import.meta.env["VITE_FIREBASE_PROJECT_ID"] as string | undefined) ?? "ai-saas-jatin",
  storageBucket:
    (import.meta.env["VITE_FIREBASE_STORAGE_BUCKET"] as string | undefined) ??
    "ai-saas-jatin.firebasestorage.app",
  messagingSenderId:
    (import.meta.env["VITE_FIREBASE_MESSAGING_SENDER_ID"] as string | undefined) ?? "306198381012",
  appId:
    (import.meta.env["VITE_FIREBASE_APP_ID"] as string | undefined) ??
    "1:306198381012:web:59b78fa482650453da5641",
};

let clientApp: FirebaseApp | undefined;
let clientAuth: Auth | undefined;
let inflightTokenPromise: Promise<string> | null = null;

const AUTH_SNAPSHOT_KEY = "studymate:auth_snapshot";
const STUDY_CACHE_PREFIX = "studymate:v1:";
const PROFILE_SYNC_TTL_MS = 5 * 60 * 1000;

interface CachedAuthSnapshot {
  uid: string;
  email: string;
  displayName: string;
  college: string;
  branch: string;
  syncedAt: number;
}

function readAuthSnapshot(): CachedAuthSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTH_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedAuthSnapshot>;
    if (!parsed || typeof parsed.uid !== "string" || !parsed.uid) return null;
    return {
      uid: parsed.uid,
      email: typeof parsed.email === "string" ? parsed.email : "",
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : "Student",
      college: typeof parsed.college === "string" ? parsed.college : "",
      branch: typeof parsed.branch === "string" ? parsed.branch : "",
      syncedAt: typeof parsed.syncedAt === "number" ? parsed.syncedAt : 0,
    };
  } catch {
    return null;
  }
}

function writeAuthSnapshot(snapshot: CachedAuthSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore storage quota errors
  }
}

export function clearPersistedStudySession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(AUTH_SNAPSHOT_KEY);
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(STUDY_CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage errors
  }
}

export function getFirebaseClientAuth(): Auth | null {
  if (typeof window === "undefined") return null;
  if (!clientApp) {
    const existing = getApps();
    clientApp = existing.length > 0 && existing[0] ? existing[0] : initializeApp(firebaseConfig);
  }
  if (!clientAuth) {
    clientAuth = getAuth(clientApp);
  }
  return clientAuth;
}

export async function getValidIdToken(): Promise<string> {
  const auth = getFirebaseClientAuth();
  if (!auth) {
    throw new Error("Firebase Auth is only available in the browser.");
  }

  if (auth.currentUser) {
    return await auth.currentUser.getIdToken();
  }

  if (inflightTokenPromise) {
    return await inflightTokenPromise;
  }

  inflightTokenPromise = (async () => {
    try {
      if (typeof auth.authStateReady === "function") {
        await auth.authStateReady();
      } else {
        await new Promise<User | null>((resolve) => {
          const timeout = setTimeout(() => {
            unsubscribe();
            resolve(auth.currentUser);
          }, 800);
          const unsubscribe = onAuthStateChanged(auth, (u) => {
            clearTimeout(timeout);
            unsubscribe();
            resolve(u);
          });
        });
      }

      if (auth.currentUser) {
        return await auth.currentUser.getIdToken();
      }

      throw new Error("Please sign in to continue.");
    } finally {
      inflightTokenPromise = null;
    }
  })();

  return await inflightTokenPromise;
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    formData?: FormData;
  } = {},
): Promise<T> {
  const token = await getValidIdToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let requestBody: BodyInit | null = null;
  if (options.formData) {
    requestBody = options.formData;
  } else if (typeof FormData !== "undefined" && options.body instanceof FormData) {
    requestBody = options.body;
  } else if (typeof options.body === "string") {
    headers["Content-Type"] = "application/json";
    requestBody = options.body;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(options.body);
  }

  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    ...(requestBody !== null ? { body: requestBody } : {}),
  });

  const data = (await res.json().catch(() => ({}))) as T & {
    error?: { code?: string; message?: string };
  };

  if (!res.ok) {
    const msg = data?.error?.message ?? `Request failed with status ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

export interface StudentMeta {
  college: string;
  branch: string;
}

export interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isAnonymous: boolean;
  displayName: string;
  email: string;
  initials: string;
  studentMeta: StudentMeta;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  signOutUser: () => Promise<void>;
  updateStudentProfile: (updates: {
    name?: string;
    displayName?: string;
    college?: string;
    branch?: string;
  }) => Promise<void>;
}

const DEFAULT_META: StudentMeta = {
  college: "",
  branch: "",
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileTick, setProfileTick] = useState(0);
  const [studentMeta, setStudentMeta] = useState<StudentMeta>(DEFAULT_META);

  useEffect(() => {
    const auth = getFirebaseClientAuth();
    if (!auth) {
      setLoading(false);
      return;
    }

    // Hydrate returning signed-in user immediately on new tab open without waiting
    // 300-700ms for Firebase IndexedDB initialization.
    const cached = readAuthSnapshot();
    if (cached?.uid) {
      setUser(
        (prev) =>
          prev ??
          ({
            uid: cached.uid,
            email: cached.email,
            displayName: cached.displayName,
            isAnonymous: false,
          } as User),
      );
      setStudentMeta({
        college: cached.college,
        branch: cached.branch,
      });
      setLoading(false);
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser && !firebaseUser.isAnonymous) {
        setUser(firebaseUser);
        setLoading(false);

        const defaultDisplayName =
          firebaseUser.displayName || firebaseUser.email?.split("@")[0] || "Student";
        const latestCached = readAuthSnapshot();
        const isSameFreshUser =
          latestCached?.uid === firebaseUser.uid &&
          Date.now() - latestCached.syncedAt < PROFILE_SYNC_TTL_MS;

        if (isSameFreshUser && latestCached) {
          setStudentMeta({
            college: latestCached.college,
            branch: latestCached.branch,
          });
          return;
        }

        try {
          const res = await apiRequest<{
            profile: {
              displayName?: string;
              email?: string;
              college?: string;
              branch?: string;
            } | null;
          }>("/api/profile");
          if (res.profile) {
            const college = res.profile.college ?? "";
            const branch = res.profile.branch ?? "";
            setStudentMeta({ college, branch });
            writeAuthSnapshot({
              uid: firebaseUser.uid,
              email: firebaseUser.email || res.profile.email || "",
              displayName:
                firebaseUser.displayName || res.profile.displayName || defaultDisplayName,
              college,
              branch,
              syncedAt: Date.now(),
            });
          } else {
            await apiRequest("/api/profile", {
              method: "POST",
              body: {
                displayName: defaultDisplayName,
                email: firebaseUser.email || "",
                college: "",
                branch: "",
              },
            });
            writeAuthSnapshot({
              uid: firebaseUser.uid,
              email: firebaseUser.email || "",
              displayName: defaultDisplayName,
              college: "",
              branch: "",
              syncedAt: Date.now(),
            });
          }
        } catch {
          // ignore if offline
        }
      } else {
        if (firebaseUser?.isAnonymous) {
          await signOut(auth).catch(() => undefined);
        }
        clearPersistedStudySession();
        setUser(null);
        setStudentMeta(DEFAULT_META);
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const auth = getFirebaseClientAuth();
    if (!auth) throw new Error("Auth unavailable");
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    const cleanName = cred.user.displayName || cred.user.email?.split("@")[0] || "Student";
    const cleanEmail = cred.user.email || email.trim();
    setUser(cred.user);
    writeAuthSnapshot({
      uid: cred.user.uid,
      email: cleanEmail,
      displayName: cleanName,
      college: "",
      branch: "",
      syncedAt: 0, // allow background profile fetch to hydrate college/branch
    });
    try {
      const res = await apiRequest<{
        profile?: { college?: string; branch?: string };
      }>("/api/profile", {
        method: "POST",
        body: {
          displayName: cleanName,
          email: cleanEmail,
        },
      });
      const college = res.profile?.college ?? "";
      const branch = res.profile?.branch ?? "";
      setStudentMeta({ college, branch });
      writeAuthSnapshot({
        uid: cred.user.uid,
        email: cleanEmail,
        displayName: cleanName,
        college,
        branch,
        syncedAt: Date.now(),
      });
    } catch {
      // ignore
    }
  }, []);

  const signUp = useCallback(async (name: string, email: string, password: string) => {
    const auth = getFirebaseClientAuth();
    if (!auth) throw new Error("Auth unavailable");
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    const cleanName = name.trim();
    if (cleanName) {
      await updateProfile(cred.user, { displayName: cleanName });
    }
    const finalName = cleanName || email.trim().split("@")[0] || "Student";
    setUser(cred.user);
    setProfileTick((t) => t + 1);
    writeAuthSnapshot({
      uid: cred.user.uid,
      email: email.trim(),
      displayName: finalName,
      college: "",
      branch: "",
      syncedAt: Date.now(),
    });
    try {
      await apiRequest("/api/profile", {
        method: "POST",
        body: {
          displayName: finalName,
          email: email.trim(),
          college: "",
          branch: "",
        },
      });
    } catch {
      // ignore
    }
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    const auth = getFirebaseClientAuth();
    if (!auth) throw new Error("Auth unavailable");
    await sendPasswordResetEmail(auth, email.trim());
  }, []);

  const signOutUser = useCallback(async () => {
    const auth = getFirebaseClientAuth();
    clearPersistedStudySession();
    if (!auth) return;
    await signOut(auth);
    setUser(null);
    setStudentMeta(DEFAULT_META);
  }, []);

  const updateStudentProfile = useCallback(
    async (updates: { name?: string; displayName?: string; college?: string; branch?: string }) => {
      const auth = getFirebaseClientAuth();
      const nextName = updates.displayName ?? updates.name;
      if (auth?.currentUser && nextName !== undefined) {
        await updateProfile(auth.currentUser, {
          displayName: nextName.trim(),
        });
        setProfileTick((t) => t + 1);
      }
      const nextMeta: StudentMeta = {
        college: updates.college !== undefined ? updates.college.trim() : studentMeta.college,
        branch: updates.branch !== undefined ? updates.branch.trim() : studentMeta.branch,
      };
      setStudentMeta(nextMeta);
      const activeUser = auth?.currentUser;
      const finalName = nextName?.trim() || activeUser?.displayName || "Student";
      const finalEmail = activeUser?.email || "";
      if (activeUser?.uid) {
        writeAuthSnapshot({
          uid: activeUser.uid,
          email: finalEmail,
          displayName: finalName,
          college: nextMeta.college,
          branch: nextMeta.branch,
          syncedAt: Date.now(),
        });
      }
      try {
        await apiRequest("/api/profile", {
          method: "POST",
          body: {
            displayName: finalName,
            email: finalEmail,
            college: nextMeta.college,
            branch: nextMeta.branch,
          },
        });
      } catch {
        // ignore
      }
    },
    [studentMeta.branch, studentMeta.college],
  );

  const value = useMemo<AuthContextValue>(() => {
    void profileTick;
    const isAnonymous = false;
    const displayName =
      user?.displayName?.trim() ||
      (user?.email ? (user.email.split("@")[0] ?? "Student") : "Student");
    const email = user?.email || "";
    const initials =
      displayName
        .split(/\s+/)
        .map((p) => p[0]?.toUpperCase() ?? "")
        .join("")
        .slice(0, 2) || "ST";

    return {
      user,
      loading,
      isAnonymous,
      displayName,
      email,
      initials,
      studentMeta,
      signIn,
      signUp,
      resetPassword,
      signOut: signOutUser,
      signOutUser,
      updateStudentProfile,
    };
  }, [
    user,
    loading,
    profileTick,
    studentMeta,
    signIn,
    signUp,
    resetPassword,
    signOutUser,
    updateStudentProfile,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

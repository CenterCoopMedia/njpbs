import { boardwalkHintCookie } from "../../../packages/content-core/src/boardwalk-edit";
import { canAccessAdmin } from "../lib/access";
import { clearStaffSiteSessions } from "../lib/staff-site";
import { clearMediaSessionCache, setMediaCachePrincipal, setMediaCacheUser } from "../lib/media-session-cache";
import { clearOwnAvatarPhoto } from "../lib/own-author-photo-cache";
import { resetUploadRouter } from "../lib/upload-router";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
  type IdTokenResult,
} from "firebase/auth";
import { collection, doc, limit, onSnapshot, query } from "firebase/firestore";
import { SECTION_LISTENER_LIMIT } from "../lib/listener-limits";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { authReducer, type AuthState } from "./authReducer";
import { auth, db } from "../lib/firebase";
import {
  registerStaffProfile,
  requestStaffPasswordReset,
  submitStaffAccessRequest,
  type StaffAccessResponse,
} from "../lib/functions";
import { adminPerf } from "../lib/perf-receipts";
import { ACCESS_TIER_ACTIVATION_PATH, validAccessTierActivation } from "../lib/access-tier-activation";
import { principalFromUserDoc, type CmsUserDoc } from "../lib/principal";
import { withRegisteredMediaSections } from "../../../packages/content-core/src/rbac";
import { CONTENT_SECTIONS_COLLECTION } from "../../../packages/content-core/src/content-sections";
import { clearConsoleLogs } from "../lib/console-capture";
import { pruneBrowserRecoveredWork } from "../lib/editor-work-recovery";
import {
  beginSessionScope,
  bindSessionToken,
  clearSessionEnded,
  deliberateSignOut,
  isSessionExpiredError,
  markDeliberateSignOut,
  markSessionEnded,
  reportSessionExpired,
  sessionEnded,
  sessionScope,
  SESSION_ENDED_EVENT,
} from "../lib/session-ended";
import {
  adminDestinationStorage,
  forgetDestination,
} from "../lib/route-memory";

interface AuthContextValue {
  state: AuthState;
  signIn: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  createAccount: (input: {
    displayName: string;
    email: string;
    password: string;
    reason: string;
  }) => Promise<StaffAccessResponse>;
  requestAccess: (reason: string) => Promise<StaffAccessResponse>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function profileFromSnapshot(
  data: CmsUserDoc | undefined,
  user: User,
): CmsUserDoc | null {
  if (!data) return null;

  return {
    ...data,
    email: data.email ?? user.email ?? null,
    displayName: data.displayName ?? user.displayName ?? null,
  };
}

function reportBackgroundError(error: unknown): void {
  if (typeof globalThis.reportError === "function") {
    globalThis.reportError(error);
  }
}

function hasHttpStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === status
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === code) return true;
  const data = (error as { data?: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === code
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, {
    status: "loading",
    stage: "session",
  });
  useEffect(() => {
    // Wait for admission and the live role profile. An auth token alone does not
    // mark a browser as staff; denial and cross-tab sign-out clear this hint.
    const cookie = boardwalkHintCookie(window.location.hostname,
      state.status === "signed-in" && canAccessAdmin(state.principal));
    if (cookie) document.cookie = cookie;
  }, [state]);

  const deniedSession = useRef<{ email: string | null } | null>(null);
  const detachSessionReads = useRef<() => void>(() => {});
  const authSession = useRef<{ user: User | null; generation: number }>({
    user: auth.currentUser,
    generation: 0,
  });
  const recordAuthState = useCallback((user: User | null, renewed = false) => {
    const current = authSession.current;
    if (current.user !== user || renewed) {
      authSession.current = {
        user,
        generation: current.generation + 1,
      };
    }
    return authSession.current.generation;
  }, []);

  const endSession = useCallback(async (expired: boolean) => {
    const cookie = boardwalkHintCookie(window.location.hostname, false);
    if (cookie) document.cookie = cookie;
    clearMediaSessionCache();
    clearOwnAvatarPhoto();
    deniedSession.current = null;
    clearConsoleLogs();
    if (expired) {
      // The person did not choose to leave, so their browser-held work waits for them. Another
      // account's sign-in still removes it, like any other change of identity.
      markSessionEnded();
    } else {
      clearSessionEnded();
      markDeliberateSignOut();
      pruneBrowserRecoveredWork(null);
    }
    // Dropped here as well as in the auth listener, so the record is gone the moment the
    // session ends rather than whenever the auth listener next runs.
    forgetDestination(adminDestinationStorage());
    await Promise.all([firebaseSignOut(auth), clearStaffSiteSessions()]);
    // The auth listener already showed the sign-in screen for an expired session. This cleanup
    // can outlast a new sign-in, so it must not write that state again.
    if (!expired) dispatch({ type: "signed-out" });
  }, []);

  const endExpiredSession = useCallback(() => {
    // Rejected authority ends before asynchronous SDK/cookie cleanup. Keep the
    // User identity so a real same-account sign-in can still be observed if
    // Firebase fails to remove its persisted session.
    const generation = authSession.current.generation + 1;
    authSession.current = { ...authSession.current, generation };
    detachSessionReads.current();
    const ending = endSession(true);
    if (generation === authSession.current.generation) {
      dispatch({ type: "signed-out", sessionEnded: true });
    }
    void ending.catch((error: unknown) => {
      reportBackgroundError(error);
      if (generation === authSession.current.generation) {
        dispatch({ type: "signed-out", sessionEnded: true });
      }
    });
  }, [endSession]);

  useEffect(() => {
    window.addEventListener(SESSION_ENDED_EVENT, endExpiredSession);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, endExpiredSession);
  }, [endExpiredSession]);

  useEffect(() => {
    let unsubscribeProfile: (() => void) | undefined;
    let unsubscribeActivation: (() => void) | undefined;
    let unsubscribeSections: (() => void) | undefined;
    let consoleIdentity: string | null | undefined;
    const detachReads = () => {
      unsubscribeProfile?.();
      unsubscribeProfile = undefined;
      unsubscribeActivation?.();
      unsubscribeActivation = undefined;
      unsubscribeSections?.();
      unsubscribeSections = undefined;
    };
    detachSessionReads.current = detachReads;

    let tokenRead = 0;
    let observedToken: { user: User; result: IdTokenResult } | undefined;
    const applyAuthState = (user: User | null, tokenResult?: IdTokenResult, renewed = false) => {
        tokenRead += 1;
        observedToken = user && tokenResult ? { user, result: tokenResult } : undefined;
        beginSessionScope(user !== null);
        // A signed-in session that vanishes without a Boardwalk sign-out was ended by Firebase:
        // a refused refresh signs out before it rejects. A first event with no session is not
        // one, so a page load stays a plain signed-out start.
        if (!user && consoleIdentity && !deliberateSignOut()) markSessionEnded();
        const keepRecoveredWork = !user && sessionEnded();
        if (!keepRecoveredWork) pruneBrowserRecoveredWork(user?.uid ?? null);
        if (user) clearSessionEnded();
        const signedOutStartup = !consoleIdentity;
        const nextConsoleIdentity = user?.uid ?? null;
        if (
          consoleIdentity !== undefined &&
          nextConsoleIdentity !== consoleIdentity
        ) {
          clearConsoleLogs();
          resetUploadRouter();
          clearOwnAvatarPhoto();
        }
        consoleIdentity = nextConsoleIdentity;
        setMediaCacheUser(nextConsoleIdentity);
        // Firebase has answered who this is, signed in or out. The first answer closes the
        // authentication boundary in the performance receipt (#1064); it records only that
        // the phase happened, never the identity it resolved.
        adminPerf.phase("authResolved");
        const generation = recordAuthState(user, renewed);
        detachReads();

        if (!user) {
          // Cross-tab sign-out and denied sessions must also cancel pending
          // preview session POSTs before clearing the private-site cookies.
          void clearStaffSiteSessions({ signedOutStartup });
          // The remembered Admin destination belongs to a session, not to the tab. Every way a
          // session can end passes through here -- the account menu, a sign-out in another tab,
          // a denial, an expired credential -- so this is where the record is dropped, rather
          // than in any one control that happens to call signOut (#1031).
          forgetDestination(adminDestinationStorage());
          const denied = deniedSession.current;
          dispatch(
            denied
              ? { type: "access-denied", email: denied.email }
              : { type: "signed-out", sessionEnded: keepRecoveredWork },
          );
          return;
        }

        deniedSession.current = null;
        dispatch({ type: "loading", stage: "admission" });

        const denyAndEndSession = (email: string | null) => {
          deniedSession.current = { email };
          markDeliberateSignOut();
          pruneBrowserRecoveredWork(null);
          forgetDestination(adminDestinationStorage());
          dispatch({ type: "access-denied", email });
          // Fire-and-forget, like the admission chain below: report a sign-out failure only
          // while this auth generation is still the one in effect. Without this check, a
          // slow-rejecting signOut that settles after the listener has moved on (a newer auth
          // state, or the provider has unmounted) still reaches reportBackgroundError, which
          // reports to the window's own uncaught-error channel with nothing left listening for
          // it.
          void firebaseSignOut(auth).catch((error: unknown) => {
            if (generation !== authSession.current.generation) return;
            reportBackgroundError(error);
          });
        };

        // Google normally supplies a verified email. Without an address the server
        // cannot bind a request or approved profile to this identity.
        if (!user.email) {
          denyAndEndSession(null);
          return;
        }

        if (!user.emailVerified) {
          dispatch({ type: "email-unverified", user });
          // An unverified session must not reach registerStaffProfile. That
          // boundary used to append auth.login.refused, which gave rejected
          // identities an unbounded audit write. The verification screen is
          // already correct without that call.
          return;
        }

        // A session now exists. Admission is measured from here rather than from the first
        // resolved auth state, because on an interactive sign-in everything between the two
        // is a person typing credentials, which is not admission latency (#1064).
        adminPerf.phase("sessionSignedIn");
        const verifiedUser = user;

        // Start the server-owned profile read with admission, but do not trust or render it
        // until the trusted boundary succeeds. The overlap removes one serial network wait
        // without caching authority or letting the profile bypass admission.
        let admissionSucceeded = false;
        let createdProfile = false;
        let createdProfileObserved = false;
        let retriedCreatedProfile = false;
        let confirmedUserDoc: CmsUserDoc | null | undefined;
        let profileError: Error | null = null;
        let registeredSections = new Set<string>();
        let sectionsSubscribed = false;
        let sectionsConfirmed = false;
        let activationSubscribed = false;
        let activationConfirmed = false;
        let tiersActive = false;

        const applyConfirmedProfile = () => {
          if (
            generation !== authSession.current.generation ||
            !admissionSucceeded
          ) return;
          if (profileError) {
            dispatch({ type: "error", error: profileError });
            return;
          }
          if (
            confirmedUserDoc === undefined ||
            (createdProfile && !createdProfileObserved)
          ) {
            return;
          }

          // Admission succeeded and a server-owned snapshot has arrived. This is the last
          // gate before the shell may mount, so it closes the profile boundary.
          if (confirmedUserDoc && Object.hasOwn(confirmedUserDoc, "accessTier")) {
            if (!activationSubscribed) {
              activationSubscribed = true;
              unsubscribeActivation = onSnapshot(
                doc(db, ACCESS_TIER_ACTIVATION_PATH),
                { includeMetadataChanges: true },
                (snapshot) => {
                  if (generation !== authSession.current.generation ||
                      snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
                  activationConfirmed = true;
                  tiersActive = snapshot.exists() && validAccessTierActivation(snapshot.data());
                  applyConfirmedProfile();
                },
                (error) => {
                  if (generation !== authSession.current.generation) return;
                  // A failed receipt read must not fall back to stale legacy authority.
                  profileError = error;
                  applyConfirmedProfile();
                },
              );
            }
            if (!activationConfirmed) return;
          }
          const storedPrincipal = principalFromUserDoc(verifiedUser.uid, confirmedUserDoc, tiersActive);
          const hasScopedGrant = storedPrincipal.grants.some((grant) =>
            Array.isArray(grant.sections) && grant.sections.length > 0);
          if (hasScopedGrant && !sectionsSubscribed) {
            sectionsSubscribed = true;
            // One live registry listener for scoped sessions. An unconfirmed or
            // empty registry confers no scoped media; picker seeds are not grants.
            unsubscribeSections = onSnapshot(
              query(collection(db, CONTENT_SECTIONS_COLLECTION), limit(SECTION_LISTENER_LIMIT + 1)),
              { includeMetadataChanges: true },
              (snapshot) => {
                if (generation !== authSession.current.generation ||
                    snapshot.metadata.hasPendingWrites ||
                    (snapshot.metadata.fromCache && !sectionsConfirmed)) return;
                // Match the server's isSectionId rule; document IDs are strings.
                const registryDocs = snapshot.docs.length > SECTION_LISTENER_LIMIT ? [] : snapshot.docs;
                registeredSections = new Set(registryDocs.map((section) => section.id)
                  .filter((id) => id.trim() !== "" && id.trim() === id));
                sectionsConfirmed = true;
                applyConfirmedProfile();
              },
              () => {
                if (generation !== authSession.current.generation) return;
                registeredSections = new Set();
                sectionsConfirmed = true;
                applyConfirmedProfile();
              },
            );
          }
          // Keep the admission screen until the scoped principal is resolved so
          // the shell does not briefly mount the access-request destination.
          if (hasScopedGrant && !sectionsConfirmed) return;
          adminPerf.phase("profileConfirmed");
          const principal = withRegisteredMediaSections(storedPrincipal, registeredSections);
          setMediaCachePrincipal(verifiedUser.uid, JSON.stringify(principal));
          dispatch({
            type: "signed-in",
            user: verifiedUser,
            principal,
            userDoc: confirmedUserDoc,
          });
        };

        const profileRef = doc(db, "users", verifiedUser.uid);

        function retryCreatedProfileRead(): boolean {
          if (
            !admissionSucceeded ||
            !createdProfile ||
            createdProfileObserved ||
            retriedCreatedProfile ||
            !profileError ||
            !hasErrorCode(profileError, "permission-denied")
          ) {
            return false;
          }
          // An older admission response can report that it created users/{uid}. Firestore denies the
          // read that started before that document existed, so attach once more after the
          // admission transaction has committed it.
          retriedCreatedProfile = true;
          subscribeProfile();
          return true;
        }

        function subscribeProfile(): void {
          unsubscribeProfile?.();
          confirmedUserDoc = undefined;
          profileError = null;
          unsubscribeProfile = onSnapshot(
            profileRef,
            { includeMetadataChanges: true },
            (snapshot) => {
              if (
                generation !== authSession.current.generation ||
                snapshot.metadata.hasPendingWrites
              ) {
                return;
              }

              confirmedUserDoc = profileFromSnapshot(
                snapshot.exists()
                  ? (snapshot.data() as CmsUserDoc)
                  : undefined,
                verifiedUser,
              );
              if (confirmedUserDoc) createdProfileObserved = true;
              applyConfirmedProfile();
            },
            (error) => {
              if (generation !== authSession.current.generation) return;
              // The rules reject a newer tokensValidAfter by failing this read, so a revocation
              // reaches an admitted session here, before its next request is refused.
              if (admissionSucceeded && confirmedUserDoc &&
                  hasErrorCode(error, "permission-denied")) {
                reportSessionExpired(sessionScope());
                return;
              }
              profileError = error;
              if (!retryCreatedProfileRead()) applyConfirmedProfile();
            },
          );
        }

        subscribeProfile();

        // Validate every verified session through the trusted server boundary before
        // trusting a users/{uid} profile. A request has no profile until an administrator approves
        // it, and Firestore rules deny all client profile creates.
        void (tokenResult ? Promise.resolve(tokenResult) : verifiedUser.getIdTokenResult())
          // Firebase can reload the verified user record while retaining a token
          // issued before verification. Refresh only that stale claim.
          .then((result) => {
            if (generation !== authSession.current.generation) return null;
            // A same-uid sign-in can replace the token while the first lookup is
            // pending. Admit the observed current session, never the old result.
            if (observedToken && observedToken.user.uid === verifiedUser.uid &&
                observedToken.result.claims.auth_time !== result.claims.auth_time) {
              applyAuthState(observedToken.user, observedToken.result, true);
              return null;
            }
            const latest = observedToken?.user.uid === verifiedUser.uid &&
              Number(observedToken.result.claims.exp) > Number(result.claims.exp) ? observedToken.result : result;
            observedToken = { user: verifiedUser, result: latest };
            return latest.claims.email_verified === true ? latest.token : verifiedUser.getIdToken(true);
          })
          // The token lookup can outlast this session. Its request must not reach the transport,
          // where a refusal would count against the session that replaced this one.
          .then((idToken) => {
            if (idToken === null || generation !== authSession.current.generation) return null;
            bindSessionToken(idToken);
            return registerStaffProfile(idToken);
          })
          .then((result) => {
            if (result === null || generation !== authSession.current.generation) return;
            // The trusted staff admission call returned. The profile listener could read
            // ahead, but no profile result was used before this boundary succeeded.
            adminPerf.phase("admissionComplete");
            admissionSucceeded = true;
            createdProfile = result.created;
            // Admission is done; only the profile snapshot remains. When it has already
            // arrived, the signed-in dispatch below lands in the same batch and this stage is
            // never painted.
            dispatch({ type: "loading", stage: "profile" });
            if (!retryCreatedProfileRead()) applyConfirmedProfile();
          })
          .catch((error: unknown) => {
            // Ignore a result from an account that has since signed out or been
            // replaced, including a sign-out followed by the same account.
            if (generation !== authSession.current.generation) return;
            detachReads();
            if (isSessionExpiredError(error)) return;

            if (hasHttpStatus(error, 403)) {
              if (hasErrorCode(error, "unverified_email")) {
                dispatch({ type: "email-unverified", user: verifiedUser });
                return;
              }
              if (hasErrorCode(error, "approval_required")) {
                const principal = principalFromUserDoc(verifiedUser.uid, null);
                setMediaCachePrincipal(verifiedUser.uid, JSON.stringify(principal));
                dispatch({
                  type: "signed-in",
                  user: verifiedUser,
                  principal,
                  userDoc: null,
                });
                return;
              }
              denyAndEndSession(verifiedUser.email);
              return;
            }

            reportBackgroundError(error);
            dispatch({
              type: "error",
              error:
                error instanceof Error ? error : new Error(String(error)),
            });
          });
      };
    const unsubscribeAuth = onAuthStateChanged(
      auth,
      applyAuthState,
      (error) => {
        dispatch({ type: "error", error });
      },
    );

    // Firebase keeps the same User object for a same-uid cross-tab sign-in and
    // emits only a token event. Cached claims identify a real new sign-in; an
    // ordinary refresh keeps admission and every existing Firestore listener.
    const unsubscribeToken = onIdTokenChanged(auth, user => {
      if (!user || user.uid !== authSession.current.user?.uid) return;
      const read = ++tokenRead;
      const generation = authSession.current.generation;
      void user.getIdTokenResult().then(result => {
        if (read !== tokenRead || generation !== authSession.current.generation) return;
        const previous = observedToken;
        observedToken = { user, result };
        if (previous && (previous.user !== user ||
            previous.result.claims.auth_time !== result.claims.auth_time)) {
          applyAuthState(user, result, true);
        } else if (previous) {
          bindSessionToken(result.token);
        }
      }).catch(error => {
        if (read === tokenRead && generation === authSession.current.generation) reportBackgroundError(error);
      });
    });

    return () => {
      tokenRead += 1;
      authSession.current = {
        user: null,
        generation: authSession.current.generation + 1,
      };
      detachReads();
      detachSessionReads.current = () => {};
      unsubscribeAuth();
      unsubscribeToken();
    };
  }, [recordAuthState]);

  const signIn = useCallback(async () => {
    const provider = new GoogleAuthProvider();
    // Always show Google's account chooser, so staff with several Google accounts can pick
    // one after sign-out instead of returning to the last account. Do not set the `hd` hint:
    // any verified address can request access.
    provider.setCustomParameters({ prompt: "select_account" });
    // Popup avoids the mobile storage-partition redirect bug from ADR 0008.
    await signInWithPopup(auth, provider);
  }, []);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    },
    [],
  );

  const createAccount = useCallback(
    async ({ displayName, email, password, reason }: {
      displayName: string;
      email: string;
      password: string;
      reason: string;
    }) => {
      const credential = await createUserWithEmailAndPassword(
        auth,
        email.trim(),
        password,
      );
      if (auth.currentUser !== credential.user) {
        throw new Error(
          "The account session changed. Continue from the account that is now signed in.",
        );
      }
      const generation = recordAuthState(credential.user);
      const isCurrentSession = () =>
        generation === authSession.current.generation &&
        authSession.current.user === credential.user &&
        auth.currentUser === credential.user;
      const showVerification = (
        verification: { error?: string; mailState?: StaffAccessResponse["mailState"] },
      ) => {
        if (!isCurrentSession()) return;
        dispatch({
          type: "email-unverified",
          user: credential.user,
          verification,
        });
      };
      try {
        const normalizedName = displayName.trim();
        if (normalizedName) {
          await updateProfile(credential.user, { displayName: normalizedName });
        }
        if (!isCurrentSession()) {
          throw new Error(
            "The account session changed. Continue from the account that is now signed in.",
          );
        }
        const idToken = await credential.user.getIdToken(true);
        if (!isCurrentSession()) {
          throw new Error(
            "The account session changed. Continue from the account that is now signed in.",
          );
        }
        const response = await submitStaffAccessRequest(idToken, reason);
        showVerification({ mailState: response.mailState });
        return response;
      } catch (error) {
        showVerification({
          error:
            error instanceof Error
              ? error.message
              : "The verification email could not be prepared.",
        });
        throw error;
      }
    },
    [recordAuthState],
  );

  const requestAccess = useCallback(async (reason: string) => {
    if (!auth.currentUser) {
      throw new Error("No signed-in user");
    }
    return submitStaffAccessRequest(
      await auth.currentUser.getIdToken(true),
      reason,
    );
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    await requestStaffPasswordReset(email.trim());
  }, []);

  const signOut = useCallback(() => endSession(false), [endSession]);

  const getIdToken = useCallback(async (forceRefresh = false) => {
    if (!auth.currentUser) {
      throw new Error("No signed-in user");
    }
    return auth.currentUser.getIdToken(forceRefresh);
  }, []);

  const value = useMemo(
    () => ({
      state,
      signIn,
      signInWithEmail,
      createAccount,
      requestAccess,
      resetPassword,
      signOut,
      getIdToken,
    }),
    [
      state,
      signIn,
      signInWithEmail,
      createAccount,
      requestAccess,
      resetPassword,
      signOut,
      getIdToken,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return value;
}

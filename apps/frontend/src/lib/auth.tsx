import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api, clearToken, getToken } from "./api";
import { User } from "../types";

interface AuthContextValue {
  user: User | null;
  isSignedIn: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  // Signing in is a full-page redirect through the backend, so there is no
  // client-side login call to hold state for — the stored token is the whole
  // session. The user record is fetched for the sidebar's account block.
  useEffect(() => {
    if (!getToken()) return;
    api.get<User>("/auth/me").then(setUser).catch(() => setUser(null));
  }, []);

  // Signs out of the identity server too, or the next "Sign in" would let
  // the same person straight back in without asking - on a shared computer,
  // that is not signing out. Asked for while the session still works; if
  // the identity server can't be reached, this browser is signed out anyway.
  async function logout() {
    let url: string | null = null;
    try {
      ({ url } = await api.get<{ url: string | null }>("/auth/oidc/logout-url"));
    } catch {
      // Signed out locally regardless.
    }
    clearToken();
    window.location.href = url ?? "/login";
  }

  return (
    <AuthContext.Provider value={{ user, isSignedIn: !!getToken(), logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

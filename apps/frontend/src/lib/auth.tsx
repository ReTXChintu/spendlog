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

  function logout() {
    clearToken();
    window.location.href = "/login";
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

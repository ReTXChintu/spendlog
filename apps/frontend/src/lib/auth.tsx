import { createContext, useContext, ReactNode } from "react";
import { clearToken, getToken } from "./api";

interface AuthContextValue {
  isSignedIn: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Signing in is a full-page redirect through the backend
  // (/auth/google/start), so there is no client-side login call to hold
  // state for — the presence of a stored token is the whole session state.
  function logout() {
    clearToken();
    window.location.href = "/login";
  }

  return <AuthContext.Provider value={{ isSignedIn: !!getToken(), logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

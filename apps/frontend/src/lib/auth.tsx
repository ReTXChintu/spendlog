import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api, clearToken, getToken, setToken } from "./api";
import { User } from "../types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  loginWithGoogleIdToken: (idToken: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    // No dedicated "me" endpoint yet — the presence of a valid token is
    // enough to unlock the app; a 401 on the first real request will
    // redirect to /login via the api client's interceptor.
    setLoading(false);
  }, []);

  async function loginWithGoogleIdToken(idToken: string) {
    const result = await api.post<{ token: string; user: User }>("/auth/google", { idToken });
    setToken(result.token);
    setUser(result.user);
  }

  function logout() {
    clearToken();
    setUser(null);
    window.location.href = "/login";
  }

  return (
    <AuthContext.Provider value={{ user, loading, loginWithGoogleIdToken, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

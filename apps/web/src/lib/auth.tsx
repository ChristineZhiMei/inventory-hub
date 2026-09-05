import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setCsrfToken } from "./api";
import type { SetupStatus, User } from "./types";

type AuthContextValue = {
  user: User | null;
  setup?: SetupStatus;
  booting: boolean;
  bootError: unknown;
  login: (credentials: { username: string; password: string }) => Promise<User>;
  logout: () => Promise<void>;
  refetch: () => Promise<unknown>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
type AuthPayload = { user: Pick<User, "id" | "username">; csrfToken: string; expiresAt: string };
const normalizeAuth = (payload: AuthPayload): User => ({ ...payload.user, csrfToken: payload.csrfToken, expiresAt: payload.expiresAt });

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const setupQuery = useQuery({ queryKey: ["setup-status"], queryFn: () => api<SetupStatus>("/setup/status"), retry: 1, staleTime: 30_000 });
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      try { return normalizeAuth(await api<AuthPayload>("/auth/me")); }
      catch (error) { if ((error as { status?: number }).status === 401) return null; throw error; }
    },
    enabled: setupQuery.data?.initialized === true,
    retry: false,
    staleTime: 60_000,
  });
  useEffect(() => setCsrfToken(meQuery.data?.csrfToken), [meQuery.data]);
  const loginMutation = useMutation({ mutationFn: async (credentials: { username: string; password: string }) => normalizeAuth(await api<AuthPayload>("/auth/login", { method: "POST", body: credentials })) });
  const logoutMutation = useMutation({ mutationFn: () => api<void>("/auth/logout", { method: "POST" }) });
  const value = useMemo<AuthContextValue>(() => ({
    user: meQuery.data ?? null,
    setup: setupQuery.data,
    booting: setupQuery.isLoading || (setupQuery.data?.initialized === true && meQuery.isLoading),
    bootError: setupQuery.error || meQuery.error,
    login: async (credentials) => { const user = await loginMutation.mutateAsync(credentials); setCsrfToken(user.csrfToken); queryClient.setQueryData(["auth", "me"], user); return user; },
    logout: async () => { await logoutMutation.mutateAsync(); setCsrfToken(); queryClient.clear(); await setupQuery.refetch(); },
    refetch: () => Promise.all([setupQuery.refetch(), meQuery.refetch()]),
  }), [loginMutation, logoutMutation, meQuery, queryClient, setupQuery]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used in AuthProvider");
  return value;
}

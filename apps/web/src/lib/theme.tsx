import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { App as AntApp, ConfigProvider, theme as antTheme } from "antd";
import zhCN from "antd/locale/zh_CN";

export type ColorTheme = "light" | "dark";

const storageKey = "inventory-hub:theme";

function storedTheme(): ColorTheme | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): ColorTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: ColorTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#111827" : "#f7f8fa");
}

const ThemeContext = createContext<{
  theme: ColorTheme;
  toggleTheme: () => void;
} | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ColorTheme>(() =>
    storedTheme() ?? systemTheme(),
  );

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    if (storedTheme()) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // The selected theme still applies for this session.
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);
  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider
        locale={zhCN}
        componentSize="large"
        button={{ autoInsertSpace: false }}
        theme={{
          algorithm:
            theme === "dark"
              ? antTheme.darkAlgorithm
              : antTheme.defaultAlgorithm,
          token: {
            colorPrimary: theme === "dark" ? "#60a5fa" : "#2563eb",
            colorInfo: theme === "dark" ? "#60a5fa" : "#2563eb",
            colorSuccess: theme === "dark" ? "#34d399" : "#059669",
            colorWarning: theme === "dark" ? "#fbbf24" : "#d97706",
            colorError: theme === "dark" ? "#f87171" : "#dc2626",
            colorBgBase: theme === "dark" ? "#111827" : "#f7f8fa",
            colorTextBase: theme === "dark" ? "#f8fafc" : "#111827",
            borderRadius: 12,
            controlHeight: 44,
            fontFamily:
              'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          },
          components: {
            Button: { controlHeight: 44, borderRadius: 10 },
            Card: { borderRadiusLG: 16 },
            Input: { controlHeight: 44 },
            Select: { controlHeight: 44 },
            Modal: { borderRadiusLG: 16 },
          },
        }}
      >
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}

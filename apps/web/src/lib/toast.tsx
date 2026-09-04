import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { cn } from "./utils";
import { Button } from "@/components/AntUi";

type Tone = "success" | "error" | "info";
type Toast = { id: string; title: string; description?: string; tone: Tone };
type ToastContextValue = { toast: (title: string, options?: { description?: string; tone?: Tone }) => void };
const ToastContext = createContext<ToastContextValue>({ toast: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const remove = useCallback((id: string) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const toast = useCallback((title: string, options: { description?: string; tone?: Tone } = {}) => {
    const id = crypto.randomUUID();
    setItems((current) => [...current.slice(-3), { id, title, description: options.description, tone: options.tone || "info" }]);
    window.setTimeout(() => remove(id), 4400);
  }, [remove]);
  const value = useMemo(() => ({ toast }), [toast]);
  return <ToastContext.Provider value={value}>{children}<div aria-live="polite" className="fixed right-4 top-4 z-[100] grid w-[min(380px,calc(100%-2rem))] gap-2">{items.map((item) => {
    const Icon = item.tone === "success" ? CheckCircle2 : item.tone === "error" ? CircleAlert : Info;
    return <div key={item.id} className={cn("surface flex gap-3 p-4 shadow-raised", item.tone === "error" && "border-destructive/40")}>
      <Icon className={cn("mt-0.5 size-5 shrink-0", item.tone === "success" ? "text-emerald-600" : item.tone === "error" ? "text-destructive" : "text-primary")} />
      <div className="min-w-0 flex-1"><p className="font-medium">{item.title}</p>{item.description && <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>}</div>
      <Button variant="ghost" size="icon" className="-m-2 text-muted-foreground" onClick={() => remove(item.id)} aria-label="关闭通知"><X className="size-4" /></Button>
    </div>;
  })}</div></ToastContext.Provider>;
}

export const useToast = () => useContext(ToastContext);

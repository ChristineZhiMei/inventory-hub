import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "./ui";

export function PageHeader({ title, actions, back }: { title: string; description?: string; actions?: ReactNode; back?: boolean }) {
  const navigate = useNavigate();
  return <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between lg:mb-7"><div className="flex min-w-0 gap-2">{back && <Button variant="ghost" size="icon" className="-ml-2 shrink-0" onClick={() => navigate(-1)} aria-label="返回"><ArrowLeft className="size-5" /></Button>}<h1 className="self-center text-2xl font-semibold tracking-tight lg:text-[1.75rem]">{title}</h1></div>{actions && <div className="flex flex-wrap gap-2">{actions}</div>}</div>;
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "页面加载失败";
  return <div className="surface grid min-h-60 place-items-center p-8 text-center"><div><p className="font-semibold text-destructive">无法加载数据</p><p className="mt-2 max-w-lg text-sm text-muted-foreground">{message}</p>{onRetry && <Button variant="outline" className="mt-5" onClick={onRetry}>重新加载</Button>}</div></div>;
}

import React from "react";
import ReactDOM from "react-dom/client";
import "@ant-design/v5-patch-for-react-19";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";
import { ToastProvider } from "./lib/toast";
import "antd/dist/reset.css";
import "antd-mobile/es/global/css-vars-patch.css";
import "./styles/theme.scss";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: (count, error) => (error as { status?: number }).status === 401 ? false : count < 1, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ThemeProvider><QueryClientProvider client={queryClient}><BrowserRouter><ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider></BrowserRouter></QueryClientProvider></ThemeProvider></React.StrictMode>,
);

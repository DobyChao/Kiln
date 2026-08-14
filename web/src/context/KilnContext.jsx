import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api";

const KilnContext = createContext(null);

export function KilnProvider({ children }) {
  const [gpu, setGpu] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [settings, setSettings] = useState({ max_concurrent: 8, gpu_exclusive: true });
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((msg) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, msg }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [gpuData, jobsData, settingsData] = await Promise.all([
        api("/gpu"),
        api("/jobs"),
        api("/settings"),
      ]);
      setGpu(gpuData);
      setJobs(jobsData.jobs || []);
      setSettings(settingsData);
    } catch {
      /* kiln backend down */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const value = useMemo(
    () => ({ gpu, jobs, settings, setSettings, toasts, toast, refresh }),
    [gpu, jobs, settings, toasts, toast, refresh],
  );

  return <KilnContext.Provider value={value}>{children}</KilnContext.Provider>;
}

export function useKiln() {
  const ctx = useContext(KilnContext);
  if (!ctx) throw new Error("useKiln must be used within KilnProvider");
  return ctx;
}

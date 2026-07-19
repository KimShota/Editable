"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../../_components/ui";

export function StartButton({ formatId }: { formatId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formatId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "could not start");
      router.push(`/jobs/${data.jobId}/resources`);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  return (
    <div>
      <Button onClick={start} disabled={loading}>
        {loading ? "Starting…" : "Use this template"}
      </Button>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}

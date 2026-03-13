"use client";

import React, { useState, useEffect, useCallback } from "react";

interface BrokerStatus {
  source: string;
  configured: boolean;
  expiresAtIso: string | null;
  expiresInMinutes: number | null;
  updatedAtIso: string | null;
  note: string;
}

interface BrokerSettingsProps {
  onTokenUpdate?: () => void;
}

export function BrokerSettings({ onTokenUpdate }: BrokerSettingsProps) {
  const [activeBroker, setActiveBroker] = useState<"upstox" | "dhan">("upstox");
  const [tokenStatus, setTokenStatus] = useState<BrokerStatus | null>(null);
  const [showTokenEditor, setShowTokenEditor] = useState<boolean>(false);
  const [tokenInput, setTokenInput] = useState<string>("");
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [message, setMessage] = useState<string>("");

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/${activeBroker}/token`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to load status");
      setTokenStatus(json);
    } catch (err) {
      setTokenStatus({
        source: "none",
        configured: false,
        expiresAtIso: null,
        expiresInMinutes: null,
        updatedAtIso: null,
        note: err instanceof Error ? err.message : "Error loading token status.",
      });
    }
  }, [activeBroker]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const saveToken = async () => {
    const token = tokenInput.trim();
    if (token.length < 20) {
      setError(`Please enter a valid ${activeBroker} token.`);
      return;
    }

    try {
      setIsBusy(true);
      setError("");
      setMessage("");
      const response = await fetch(`/api/${activeBroker}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to save token");
      
      setTokenStatus(json);
      setTokenInput("");
      setShowTokenEditor(false);
      setMessage("Token saved successfully.");
      onTokenUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save token.");
    } finally {
      setIsBusy(false);
    }
  };

  const clearToken = async () => {
    try {
      setIsBusy(true);
      setError("");
      setMessage("");
      const response = await fetch(`/api/${activeBroker}/token`, { method: "DELETE" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to clear token");
      
      setTokenStatus(json);
      setMessage("Token cleared.");
      onTokenUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear token.");
    } finally {
      setIsBusy(false);
    }
  };

  const getStatusClass = (status: BrokerStatus | null) => {
    if (!status?.configured) return "status-pill-none";
    if (status.expiresInMinutes !== null && status.expiresInMinutes < 60) return "status-pill-error";
    return "status-pill-success";
  };

  const formatExpiry = (iso: string | null) => {
    if (!iso) return "N/A";
    return new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: false,
    });
  };

  return (
    <div className="token-panel">
      <div className="token-panel-head">
        <div className="broker-tabs">
          <button 
            className={`tab-btn ${activeBroker === "upstox" ? "active" : ""}`}
            onClick={() => setActiveBroker("upstox")}
          >
            Upstox
          </button>
          <button 
            className={`tab-btn ${activeBroker === "dhan" ? "active" : ""}`}
            onClick={() => setActiveBroker("dhan")}
          >
            Dhan
          </button>
        </div>
        <span className={`status-pill ${getStatusClass(tokenStatus)}`}>
          {tokenStatus?.configured ? "CONNECTED" : "DISCONNECTED"}
        </span>
      </div>

      <div className="token-info">
        <p className="token-panel-meta">
          Source: <strong>{tokenStatus?.source ?? "none"}</strong>
          {" "}&nbsp;|&nbsp;{" "}
          Expiry: <strong>{formatExpiry(tokenStatus?.expiresAtIso || null)}</strong>
        </p>
        <p className="token-panel-note">{tokenStatus?.note ?? "Configure token to enable live market data."}</p>
      </div>

      <div className="token-actions">
        {activeBroker === "upstox" && (
          <a className="token-btn" href="/api/upstox/authorize">
            Authorize via OTP
          </a>
        )}
        <button
          type="button"
          className="token-btn"
          onClick={() => {
            setShowTokenEditor((v) => !v);
            setError("");
            setMessage("");
          }}
          disabled={isBusy}
        >
          {showTokenEditor ? "Close" : "Paste Token"}
        </button>
        <button
          type="button"
          className="token-btn token-btn-ghost"
          onClick={clearToken}
          disabled={isBusy || !tokenStatus?.configured}
        >
          Clear
        </button>
      </div>

      {showTokenEditor && (
        <div className="token-editor">
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={`Paste ${activeBroker} API token here`}
            autoComplete="off"
          />
          <button
            type="button"
            className="token-btn"
            onClick={saveToken}
            disabled={isBusy || !tokenInput.trim()}
          >
            {isBusy ? "Saving…" : "Save Token"}
          </button>
        </div>
      )}

      {error   && <p className="error-text">{error}</p>}
      {message && <p className="token-success">{message}</p>}

      <style jsx>{`
        .broker-tabs {
          display: flex;
          gap: 8px;
        }
        .tab-btn {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #aaa;
          padding: 4px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          transition: all 0.2s;
        }
        .tab-btn:hover {
          background: rgba(255, 255, 255, 0.1);
        }
        .tab-btn.active {
          background: #3b82f6;
          border-color: #3b82f6;
          color: white;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}

/**
 * Quota cache that survives route switches.
 */

import { create } from 'zustand';
import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  GeminiCliQuotaState,
  KimiQuotaState,
  XaiQuotaState,
} from '@/types';

type QuotaUpdater<T> = T | ((prev: T) => T);
type CredentialValidityStatus = 'valid' | 'invalid';
type CredentialValidityCache = Record<string, Record<string, CredentialValidityStatus>>;

interface QuotaStoreState {
  antigravityQuota: Record<string, AntigravityQuotaState>;
  claudeQuota: Record<string, ClaudeQuotaState>;
  codexQuota: Record<string, CodexQuotaState>;
  geminiCliQuota: Record<string, GeminiCliQuotaState>;
  kimiQuota: Record<string, KimiQuotaState>;
  xaiQuota: Record<string, XaiQuotaState>;
  credentialValidityCache: CredentialValidityCache;
  setAntigravityQuota: (updater: QuotaUpdater<Record<string, AntigravityQuotaState>>) => void;
  setClaudeQuota: (updater: QuotaUpdater<Record<string, ClaudeQuotaState>>) => void;
  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;
  setGeminiCliQuota: (updater: QuotaUpdater<Record<string, GeminiCliQuotaState>>) => void;
  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;
  setXaiQuota: (updater: QuotaUpdater<Record<string, XaiQuotaState>>) => void;
  setCredentialValidityCache: (
    type: string,
    updater: QuotaUpdater<Record<string, CredentialValidityStatus>>
  ) => void;
  clearQuotaCache: () => void;
}

const resolveUpdater = <T>(updater: QuotaUpdater<T>, prev: T): T => {
  if (typeof updater === 'function') {
    return (updater as (value: T) => T)(prev);
  }
  return updater;
};

export const useQuotaStore = create<QuotaStoreState>((set) => ({
  antigravityQuota: {},
  claudeQuota: {},
  codexQuota: {},
  geminiCliQuota: {},
  kimiQuota: {},
  xaiQuota: {},
  credentialValidityCache: {},
  setAntigravityQuota: (updater) =>
    set((state) => ({
      antigravityQuota: resolveUpdater(updater, state.antigravityQuota),
    })),
  setClaudeQuota: (updater) =>
    set((state) => ({
      claudeQuota: resolveUpdater(updater, state.claudeQuota),
    })),
  setCodexQuota: (updater) =>
    set((state) => ({
      codexQuota: resolveUpdater(updater, state.codexQuota),
    })),
  setGeminiCliQuota: (updater) =>
    set((state) => ({
      geminiCliQuota: resolveUpdater(updater, state.geminiCliQuota),
    })),
  setKimiQuota: (updater) =>
    set((state) => ({
      kimiQuota: resolveUpdater(updater, state.kimiQuota),
    })),
  setXaiQuota: (updater) =>
    set((state) => ({
      xaiQuota: resolveUpdater(updater, state.xaiQuota),
    })),
  setCredentialValidityCache: (type, updater) =>
    set((state) => {
      const prevTypeCache = state.credentialValidityCache[type] ?? {};
      const nextTypeCache = resolveUpdater(updater, prevTypeCache);

      if (nextTypeCache === prevTypeCache) {
        return state;
      }

      return {
        credentialValidityCache: {
          ...state.credentialValidityCache,
          [type]: nextTypeCache
        }
      };
    }),
  clearQuotaCache: () =>
    set({
      antigravityQuota: {},
      claudeQuota: {},
      codexQuota: {},
      geminiCliQuota: {},
      kimiQuota: {},
      xaiQuota: {},
      credentialValidityCache: {}
    }),
}));

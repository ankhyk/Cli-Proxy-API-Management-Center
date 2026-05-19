/**
 * Generic hook for quota data fetching and management.
 */

import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import { useQuotaStore } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import type { QuotaConfig } from './quotaConfigs';

type QuotaScope = 'page' | 'all';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

type CredentialValidityStatus = 'valid' | 'invalid';

interface LoadQuotaOptions {
  onCredentialValidityChange?: (fileName: string, status: CredentialValidityStatus) => void;
}

const QUOTA_REFRESH_CONCURRENCY_LIMIT = 4;

const runWithConcurrencyLimit = async <T,>(
  items: T[],
  concurrencyLimit: number,
  task: (item: T) => Promise<void>
) => {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrencyLimit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await task(items[currentIndex]);
      }
    })
  );
};

export function useQuotaLoader<TState, TData>(config: QuotaConfig<TState, TData>) {
  const { t } = useTranslation();
  const quota = useQuotaStore(config.storeSelector);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;
  const setCredentialValidityCache = useQuotaStore(
    (state) => state.setCredentialValidityCache
  );

  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    async (
      targets: AuthFileItem[],
      scope: QuotaScope,
      setLoading: (loading: boolean, scope?: QuotaScope | null) => void,
      options?: LoadQuotaOptions
    ) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      setLoading(true, scope);

      try {
        if (targets.length === 0) return;

        setQuota((prev) => {
          const nextState = { ...prev };
          targets.forEach((file) => {
            nextState[file.name] = config.buildLoadingState();
          });
          return nextState;
        });

        const allCredentialValidityResults: Record<string, CredentialValidityStatus> = {};
        const publishCredentialValidity = (fileName: string, status: CredentialValidityStatus) => {
          if (scope === 'all') {
            allCredentialValidityResults[fileName] = status;
            options?.onCredentialValidityChange?.(fileName, status);
            return;
          }

          setCredentialValidityCache(config.type, (prev) => {
            if (prev[fileName] === status) return prev;
            return {
              ...prev,
              [fileName]: status
            };
          });
        };

        await runWithConcurrencyLimit(
          targets,
          QUOTA_REFRESH_CONCURRENCY_LIMIT,
          async (file) => {
            try {
              const data = await config.fetchQuota(file, t);
              if (requestId !== requestIdRef.current) return;

              setQuota((prev) => ({
                ...prev,
                [file.name]: config.buildSuccessState(data)
              }));
              publishCredentialValidity(file.name, 'valid');
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : t('common.unknown_error');
              const errorStatus = getStatusFromError(err);
              if (requestId !== requestIdRef.current) return;

              setQuota((prev) => ({
                ...prev,
                [file.name]: config.buildErrorState(message, errorStatus)
              }));
              publishCredentialValidity(file.name, 'invalid');
            }
          }
        );

        if (scope === 'all' && requestId === requestIdRef.current) {
          setCredentialValidityCache(config.type, (prev) => {
            const nextState: Record<string, CredentialValidityStatus> = {};

            targets.forEach((file) => {
              const nextStatus = allCredentialValidityResults[file.name] ?? prev[file.name];
              if (nextStatus) {
                nextState[file.name] = nextStatus;
              }
            });

            const prevKeys = Object.keys(prev);
            const nextKeys = Object.keys(nextState);
            const changed =
              prevKeys.length !== nextKeys.length ||
              nextKeys.some((fileName) => prev[fileName] !== nextState[fileName]);

            return changed ? nextState : prev;
          });
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          loadingRef.current = false;
        }
      }
    },
    [config, setCredentialValidityCache, setQuota, t]
  );

  return { quota, loadQuota };
}

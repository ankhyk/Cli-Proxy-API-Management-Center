/**
 * Generic quota section component.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { authFilesApi } from '@/services/api';
import { useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getStatusFromError, isRuntimeOnlyAuthFile } from '@/utils/quota';
import { QuotaCard, QuotaProgressBar } from './QuotaCard';
import type { QuotaStatusState } from './QuotaCard';
import { useQuotaLoader } from './useQuotaLoader';
import {
  QUOTA_PROGRESS_HIGH_THRESHOLD,
  QUOTA_PROGRESS_MEDIUM_THRESHOLD,
  type QuotaConfig,
} from './quotaConfigs';
import { useGridColumns } from './useGridColumns';
import { IconCheck, IconRefreshCw, IconTrash2, IconX } from '@/components/ui/icons';
import styles from '@/pages/QuotaPage.module.scss';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

type ViewMode = 'paged' | 'all';
type QuotaRefreshScope = 'page' | 'all';
type CredentialValidityStatus = 'valid' | 'invalid';
type CredentialValidityFilter = 'all' | `status:${number}`;
type QuotaDeleteScope = 'selected' | 'filtered';

interface CredentialStatusInfo {
  status?: CredentialValidityStatus;
  errorStatus?: number;
}

interface CredentialRefreshProgress {
  valid: number;
  invalid: number;
  statuses: Record<string, CredentialValidityStatus>;
}

interface WeeklyQuotaSummary {
  percent: number;
  percentLabel: string;
  amountLabel: string | null;
}

const MAX_ITEMS_PER_PAGE = 25;
const MAX_SHOW_ALL_THRESHOLD = 30;
const EMPTY_CREDENTIAL_VALIDITY_CACHE: Record<string, CredentialValidityStatus> = {};
const HTTP_STATUS_FILTER_PREFIX = 'status:';

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const formatQuotaNumber = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.0001) return String(rounded);
  return value.toFixed(2).replace(/\.?0+$/, '');
};

const uniqueFileNames = (names: string[]): string[] =>
  Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));

const getCredentialFilterHttpStatus = (filter: CredentialValidityFilter): number | null => {
  if (!filter.startsWith(HTTP_STATUS_FILTER_PREFIX)) return null;
  const status = Number(filter.slice(HTTP_STATUS_FILTER_PREFIX.length));
  return Number.isInteger(status) ? status : null;
};

interface QuotaPaginationState<T> {
  pageSize: number;
  totalPages: number;
  currentPage: number;
  pageItems: T[];
  setPageSize: (size: number) => void;
  goToPrev: () => void;
  goToNext: () => void;
  loading: boolean;
  loadingScope: QuotaRefreshScope | null;
  setLoading: (loading: boolean, scope?: QuotaRefreshScope | null) => void;
}

const useQuotaPagination = <T,>(items: T[], defaultPageSize = 6): QuotaPaginationState<T> => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);
  const [loading, setLoadingState] = useState(false);
  const [loadingScope, setLoadingScope] = useState<QuotaRefreshScope | null>(null);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(items.length / pageSize)),
    [items.length, pageSize]
  );

  const currentPage = useMemo(() => Math.min(page, totalPages), [page, totalPages]);

  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, currentPage, pageSize]);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPage(1);
  }, []);

  const goToPrev = useCallback(() => {
    setPage((prev) => Math.max(1, prev - 1));
  }, []);

  const goToNext = useCallback(() => {
    setPage((prev) => Math.min(totalPages, prev + 1));
  }, [totalPages]);

  const setLoading = useCallback((isLoading: boolean, scope?: QuotaRefreshScope | null) => {
    setLoadingState(isLoading);
    setLoadingScope(isLoading ? (scope ?? null) : null);
  }, []);

  return {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
    loading,
    loadingScope,
    setLoading,
  };
};

interface QuotaSectionProps<TState extends QuotaStatusState, TData> {
  config: QuotaConfig<TState, TData>;
  files: AuthFileItem[];
  loading: boolean;
  disabled: boolean;
  onFilesDeleted?: (names: string[]) => void;
}

export function QuotaSection<TState extends QuotaStatusState, TData>({
  config,
  files,
  loading,
  disabled,
  onFilesDeleted,
}: QuotaSectionProps<TState, TData>) {
  const { t } = useTranslation();
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;

  /* Removed useRef */
  const [columns, gridRef] = useGridColumns(380); // Min card width 380px matches SCSS
  const [viewMode, setViewMode] = useState<ViewMode>('paged');
  const [showTooManyWarning, setShowTooManyWarning] = useState(false);
  const [credentialFilter, setCredentialFilter] = useState<CredentialValidityFilter>('all');
  const [selectedFileNames, setSelectedFileNames] = useState<Set<string>>(new Set());
  const [deletingScope, setDeletingScope] = useState<QuotaDeleteScope | null>(null);

  const filteredFiles = useMemo(
    () => files.filter((file) => config.filterFn(file)),
    [files, config]
  );

  const { quota, loadQuota } = useQuotaLoader(config);
  const credentialValidityCache = useQuotaStore(
    (state) => state.credentialValidityCache[config.type] ?? EMPTY_CREDENTIAL_VALIDITY_CACHE
  );
  const setCredentialValidityCache = useQuotaStore((state) => state.setCredentialValidityCache);

  const credentialStatusByFileName = useMemo(() => {
    const result = new Map<string, CredentialStatusInfo>();

    filteredFiles.forEach((file) => {
      const currentQuota = quota[file.name];
      if (currentQuota?.status === 'success') {
        result.set(file.name, { status: 'valid' });
        return;
      }

      if (currentQuota?.status === 'error') {
        result.set(file.name, {
          status: 'invalid',
          errorStatus: currentQuota.errorStatus,
        });
        return;
      }

      const cachedStatus = credentialValidityCache[file.name];
      if (cachedStatus === 'valid') {
        result.set(file.name, { status: 'valid' });
      } else if (cachedStatus === 'invalid') {
        result.set(file.name, { status: 'invalid' });
      }
    });

    return result;
  }, [credentialValidityCache, filteredFiles, quota]);

  const credentialFilterCounts = useMemo(() => {
    const counts = {
      all: filteredFiles.length,
      statusCounts: [] as Array<{ status: number; count: number }>,
    };
    const statusCounts = new Map<number, number>();

    filteredFiles.forEach((file) => {
      const credentialStatus = credentialStatusByFileName.get(file.name);
      if (credentialStatus?.status !== 'invalid') return;

      const errorStatus = credentialStatus.errorStatus;
      if (typeof errorStatus === 'number' && Number.isInteger(errorStatus)) {
        statusCounts.set(errorStatus, (statusCounts.get(errorStatus) ?? 0) + 1);
      }
    });

    counts.statusCounts = Array.from(statusCounts.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((left, right) => left.status - right.status);

    return counts;
  }, [credentialStatusByFileName, filteredFiles]);

  const credentialFilteredFiles = useMemo(() => {
    if (credentialFilter === 'all') return filteredFiles;
    const filteredHttpStatus = getCredentialFilterHttpStatus(credentialFilter);

    return filteredFiles.filter((file) => {
      const credentialStatus = credentialStatusByFileName.get(file.name);
      if (credentialStatus?.status !== 'invalid') return false;
      return credentialStatus.errorStatus === filteredHttpStatus;
    });
  }, [credentialFilter, credentialStatusByFileName, filteredFiles]);

  const showAllAllowed = credentialFilteredFiles.length <= MAX_SHOW_ALL_THRESHOLD;
  const effectiveViewMode: ViewMode = viewMode === 'all' && !showAllAllowed ? 'paged' : viewMode;

  const {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
    loading: sectionLoading,
    loadingScope,
    setLoading,
  } = useQuotaPagination(credentialFilteredFiles);

  useEffect(() => {
    if (showAllAllowed) return;
    if (viewMode !== 'all') return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setViewMode('paged');
      setShowTooManyWarning(true);
    });

    return () => {
      cancelled = true;
    };
  }, [showAllAllowed, viewMode]);

  // Update page size based on view mode and columns
  useEffect(() => {
    if (effectiveViewMode === 'all') {
      setPageSize(Math.max(1, credentialFilteredFiles.length));
    } else {
      // Paged mode: 3 rows * columns, capped to avoid oversized pages.
      setPageSize(Math.min(columns * 3, MAX_ITEMS_PER_PAGE));
    }
  }, [effectiveViewMode, columns, credentialFilteredFiles.length, setPageSize]);

  const [pendingQuotaRefreshScope, setPendingQuotaRefreshScope] =
    useState<QuotaRefreshScope | null>(null);
  const [allCredentialRefreshProgress, setAllCredentialRefreshProgress] =
    useState<CredentialRefreshProgress | null>(null);

  const updateAllCredentialRefreshProgress = useCallback(
    (fileName: string, status: CredentialValidityStatus) => {
      setAllCredentialRefreshProgress((prev) => {
        if (!prev) return prev;

        const previousStatus = prev.statuses[fileName];
        if (previousStatus === status) return prev;

        return {
          valid: prev.valid + (status === 'valid' ? 1 : 0) - (previousStatus === 'valid' ? 1 : 0),
          invalid:
            prev.invalid + (status === 'invalid' ? 1 : 0) - (previousStatus === 'invalid' ? 1 : 0),
          statuses: {
            ...prev.statuses,
            [fileName]: status,
          },
        };
      });
    },
    []
  );

  useEffect(() => {
    if (loading) return;
    if (pendingQuotaRefreshScope === 'all') return;
    if (sectionLoading && loadingScope === 'all') return;

    setCredentialValidityCache(config.type, (prev) => {
      const nextState: Record<string, CredentialValidityStatus> = {};

      filteredFiles.forEach((file) => {
        const quotaStatus = quota[file.name]?.status;
        const cachedStatus = prev[file.name];
        const nextStatus =
          quotaStatus === 'success' ? 'valid' : quotaStatus === 'error' ? 'invalid' : cachedStatus;

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
  }, [
    config.type,
    filteredFiles,
    loading,
    loadingScope,
    pendingQuotaRefreshScope,
    quota,
    sectionLoading,
    setCredentialValidityCache,
  ]);

  const cachedCredentialCounts = useMemo(
    () =>
      filteredFiles.reduce(
        (counts, file) => {
          const credentialStatus = credentialStatusByFileName.get(file.name)?.status;
          if (credentialStatus === 'valid') {
            counts.validCredentialCount += 1;
          } else if (credentialStatus === 'invalid') {
            counts.invalidCredentialCount += 1;
          }
          return counts;
        },
        { validCredentialCount: 0, invalidCredentialCount: 0 }
      ),
    [credentialStatusByFileName, filteredFiles]
  );

  const showAllRefreshProgress =
    allCredentialRefreshProgress !== null &&
    (pendingQuotaRefreshScope === 'all' || (sectionLoading && loadingScope === 'all'));
  const validCredentialCount = showAllRefreshProgress
    ? allCredentialRefreshProgress.valid
    : cachedCredentialCounts.validCredentialCount;
  const invalidCredentialCount = showAllRefreshProgress
    ? allCredentialRefreshProgress.invalid
    : cachedCredentialCounts.invalidCredentialCount;
  const checkedCredentialCount = validCredentialCount + invalidCredentialCount;
  const weeklyQuotaSummary = useMemo<WeeklyQuotaSummary | null>(() => {
    const getWeeklyLimitItems = config.getWeeklyLimitItems;
    if (!getWeeklyLimitItems) return null;

    let percentTotal = 0;
    let percentCount = 0;
    let usedTotal = 0;
    let limitTotal = 0;
    let numericCount = 0;

    filteredFiles.forEach((file) => {
      const current = quota[file.name];
      if (current?.status !== 'success') return;

      getWeeklyLimitItems(current).forEach((item) => {
        if (typeof item.remainingPercent === 'number' && Number.isFinite(item.remainingPercent)) {
          percentTotal += clampPercent(item.remainingPercent);
          percentCount += 1;
        }

        if (typeof item.limit === 'number' && Number.isFinite(item.limit) && item.limit > 0) {
          const used = typeof item.used === 'number' && Number.isFinite(item.used) ? item.used : 0;
          usedTotal += used;
          limitTotal += item.limit;
          numericCount += 1;
        }
      });
    });

    if (numericCount > 0 && limitTotal > 0) {
      const remaining = clampPercent(Math.round(((limitTotal - usedTotal) / limitTotal) * 100));
      return {
        percent: remaining,
        percentLabel: `${remaining}%`,
        amountLabel: `${formatQuotaNumber(usedTotal)} / ${formatQuotaNumber(limitTotal)}`,
      };
    }

    if (percentCount === 0) return null;

    const percent = clampPercent(Math.round(percentTotal / percentCount));
    return {
      percent,
      percentLabel: `${percent}%`,
      amountLabel: null,
    };
  }, [config, filteredFiles, quota]);

  const prevFilesLoadingRef = useRef(loading);

  const handleRefresh = useCallback((scope: QuotaRefreshScope) => {
    if (scope === 'all') {
      setAllCredentialRefreshProgress({ valid: 0, invalid: 0, statuses: {} });
    }
    setPendingQuotaRefreshScope(scope);
    void triggerHeaderRefresh();
  }, []);

  useEffect(() => {
    const wasLoading = prevFilesLoadingRef.current;
    prevFilesLoadingRef.current = loading;

    const pendingScope = pendingQuotaRefreshScope;
    if (!pendingScope) return;
    if (loading) return;
    if (!wasLoading) return;

    queueMicrotask(() => setPendingQuotaRefreshScope(null));
    const targets = pendingScope === 'all' ? filteredFiles : pageItems;
    if (targets.length === 0) return;
    loadQuota(targets, pendingScope, setLoading, {
      onCredentialValidityChange:
        pendingScope === 'all' ? updateAllCredentialRefreshProgress : undefined,
    });
  }, [
    loading,
    pendingQuotaRefreshScope,
    filteredFiles,
    pageItems,
    loadQuota,
    setLoading,
    updateAllCredentialRefreshProgress,
  ]);

  useEffect(() => {
    if (loading) return;
    if (filteredFiles.length === 0) {
      setQuota({});
      return;
    }
    setQuota((prev) => {
      const nextState: Record<string, TState> = {};
      filteredFiles.forEach((file) => {
        const cached = prev[file.name];
        if (cached) {
          nextState[file.name] = cached;
        }
      });
      return nextState;
    });
  }, [filteredFiles, loading, setQuota]);

  const refreshQuotaForFile = useCallback(
    async (file: AuthFileItem) => {
      if (disabled || file.disabled) return;
      if (quota[file.name]?.status === 'loading') return;

      setQuota((prev) => ({
        ...prev,
        [file.name]: config.buildLoadingState(),
      }));

      try {
        const data = await config.fetchQuota(file, t);
        setQuota((prev) => ({
          ...prev,
          [file.name]: config.buildSuccessState(data),
        }));
        showNotification(t('auth_files.quota_refresh_success', { name: file.name }), 'success');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status = getStatusFromError(err);
        setQuota((prev) => ({
          ...prev,
          [file.name]: config.buildErrorState(message, status),
        }));
        showNotification(
          t('auth_files.quota_refresh_failed', { name: file.name, message }),
          'error'
        );
      }
    },
    [config, disabled, quota, setQuota, showNotification, t]
  );

  const selectablePageItems = useMemo(
    () => pageItems.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [pageItems]
  );

  const filteredFileNameSet = useMemo(
    () => new Set(filteredFiles.map((file) => file.name)),
    [filteredFiles]
  );

  const selectedCredentialNames = useMemo(
    () => Array.from(selectedFileNames).filter((name) => filteredFileNameSet.has(name)),
    [filteredFileNameSet, selectedFileNames]
  );

  const filteredDeletableFiles = useMemo(
    () => credentialFilteredFiles.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [credentialFilteredFiles]
  );

  useEffect(() => {
    if (selectedFileNames.size === 0) return;

    setSelectedFileNames((prev) => {
      let changed = false;
      const next = new Set<string>();

      prev.forEach((name) => {
        if (filteredFileNameSet.has(name)) {
          next.add(name);
        } else {
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [filteredFileNameSet, selectedFileNames.size]);

  const toggleCredentialSelection = useCallback((name: string, selected: boolean) => {
    setSelectedFileNames((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
  }, []);

  const selectCurrentPageCredentials = useCallback(() => {
    if (selectablePageItems.length === 0) return;

    setSelectedFileNames((prev) => {
      const next = new Set(prev);
      selectablePageItems.forEach((file) => next.add(file.name));
      return next;
    });
  }, [selectablePageItems]);

  const clearSelectedCredentials = useCallback(() => {
    setSelectedFileNames(new Set());
  }, []);

  const applyDeletedCredentialNames = useCallback(
    (names: string[]) => {
      const deletedNames = uniqueFileNames(names);
      if (deletedNames.length === 0) return;
      const deletedNameSet = new Set(deletedNames);

      onFilesDeleted?.(deletedNames);

      setSelectedFileNames((prev) => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Set<string>();
        prev.forEach((name) => {
          if (deletedNameSet.has(name)) {
            changed = true;
          } else {
            next.add(name);
          }
        });
        return changed ? next : prev;
      });

      setQuota((prev) => {
        let changed = false;
        const nextState: Record<string, TState> = {};
        Object.entries(prev).forEach(([name, value]) => {
          if (deletedNameSet.has(name)) {
            changed = true;
            return;
          }
          nextState[name] = value;
        });
        return changed ? nextState : prev;
      });

      setCredentialValidityCache(config.type, (prev) => {
        let changed = false;
        const nextState: Record<string, CredentialValidityStatus> = {};
        Object.entries(prev).forEach(([name, value]) => {
          if (deletedNameSet.has(name)) {
            changed = true;
            return;
          }
          nextState[name] = value;
        });
        return changed ? nextState : prev;
      });
    },
    [config.type, onFilesDeleted, setCredentialValidityCache, setQuota]
  );

  const deleteCredentials = useCallback(
    (targetFiles: AuthFileItem[], scope: QuotaDeleteScope) => {
      const targetNames = uniqueFileNames(
        targetFiles.filter((file) => !isRuntimeOnlyAuthFile(file)).map((file) => file.name)
      );

      if (targetNames.length === 0) {
        if (scope === 'filtered') {
          showNotification(t('quota_management.delete_filtered_credentials_none'), 'info');
        }
        return;
      }

      showConfirmation({
        title: t('quota_management.delete_credentials_title'),
        message:
          scope === 'selected'
            ? t('quota_management.delete_selected_credentials_confirm', {
                count: targetNames.length,
              })
            : t('quota_management.delete_filtered_credentials_confirm', {
                count: targetNames.length,
              }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          setDeletingScope(scope);
          try {
            const result = await authFilesApi.deleteFiles(targetNames);
            const failedNames = new Set(
              result.failed.map((item) => item.name.trim()).filter(Boolean)
            );
            const deletedNames =
              result.files.length > 0
                ? result.files
                : targetNames.filter((name) => !failedNames.has(name));
            const success = deletedNames.length || result.deleted;
            const failed = result.failed.length;

            applyDeletedCredentialNames(deletedNames);

            showNotification(
              failed === 0
                ? t('quota_management.delete_credentials_success', { count: success })
                : t('quota_management.delete_credentials_partial', { success, failed }),
              failed === 0 ? 'success' : 'warning'
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
          } finally {
            setDeletingScope(null);
          }
        },
      });
    },
    [applyDeletedCredentialNames, showConfirmation, showNotification, t]
  );

  const deleteSelectedCredentials = useCallback(() => {
    const selectedNameSet = new Set(selectedCredentialNames);
    deleteCredentials(
      filteredFiles.filter((file) => selectedNameSet.has(file.name)),
      'selected'
    );
  }, [deleteCredentials, filteredFiles, selectedCredentialNames]);

  const deleteFilteredCredentials = useCallback(() => {
    deleteCredentials(filteredDeletableFiles, 'filtered');
  }, [deleteCredentials, filteredDeletableFiles]);

  const titleNode = (
    <div className={styles.titleWrapper}>
      <span>{t(`${config.i18nPrefix}.title`)}</span>
      {filteredFiles.length > 0 && (
        <span className={styles.countBadge}>{filteredFiles.length}</span>
      )}
      {filteredFiles.length > 0 && (
        <span
          className={`${styles.credentialCountBadge} ${
            invalidCredentialCount > 0 ? styles.credentialCountBadgeWarning : ''
          }`}
          title={t('quota_management.valid_credentials_count', {
            checked: checkedCredentialCount,
            valid: validCredentialCount,
            invalid: invalidCredentialCount,
            total: filteredFiles.length,
          })}
          aria-label={t('quota_management.valid_credentials_count', {
            checked: checkedCredentialCount,
            valid: validCredentialCount,
            invalid: invalidCredentialCount,
            total: filteredFiles.length,
          })}
        >
          <span className={styles.credentialCountItem}>
            <span className={styles.credentialCountLabel}>
              {t('quota_management.checked_credentials_label')}
            </span>
            <span className={styles.credentialCountValue}>
              {checkedCredentialCount}/{filteredFiles.length}
            </span>
          </span>
          <span className={styles.credentialCountItem}>
            <span className={styles.credentialCountLabel}>
              {t('quota_management.valid_credentials_label')}
            </span>
            <span className={`${styles.credentialCountValue} ${styles.credentialCountValueValid}`}>
              {validCredentialCount}
            </span>
          </span>
          <span className={styles.credentialCountItem}>
            <span className={styles.credentialCountLabel}>
              {t('quota_management.invalid_credentials_label')}
            </span>
            <span
              className={`${styles.credentialCountValue} ${styles.credentialCountValueInvalid}`}
            >
              {invalidCredentialCount}
            </span>
          </span>
        </span>
      )}
      {weeklyQuotaSummary && (
        <div
          className={styles.totalQuotaSummary}
          title={`${t('quota_management.total_weekly_limit')}: ${
            weeklyQuotaSummary.percentLabel
          }${weeklyQuotaSummary.amountLabel ? ` ${weeklyQuotaSummary.amountLabel}` : ''}`}
          aria-label={`${t('quota_management.total_weekly_limit')}: ${
            weeklyQuotaSummary.percentLabel
          }${weeklyQuotaSummary.amountLabel ? ` ${weeklyQuotaSummary.amountLabel}` : ''}`}
        >
          <div className={styles.totalQuotaHeader}>
            <span className={styles.totalQuotaLabel}>
              {t('quota_management.total_weekly_limit')}
            </span>
            <div className={styles.totalQuotaMeta}>
              <span className={styles.quotaPercent}>{weeklyQuotaSummary.percentLabel}</span>
              {weeklyQuotaSummary.amountLabel && (
                <span className={styles.quotaAmount}>{weeklyQuotaSummary.amountLabel}</span>
              )}
            </div>
          </div>
          <QuotaProgressBar
            percent={weeklyQuotaSummary.percent}
            highThreshold={QUOTA_PROGRESS_HIGH_THRESHOLD}
            mediumThreshold={QUOTA_PROGRESS_MEDIUM_THRESHOLD}
          />
        </div>
      )}
    </div>
  );

  const isRefreshing = sectionLoading || loading;
  const isRefreshingCurrentPage =
    (loading && pendingQuotaRefreshScope === 'page') || (sectionLoading && loadingScope === 'page');
  const isRefreshingAllCredentials =
    (loading && pendingQuotaRefreshScope === 'all') || (sectionLoading && loadingScope === 'all');
  const selectedCredentialCount = selectedCredentialNames.length;
  const isDeletingCredentials = deletingScope !== null;
  const isDeletingSelectedCredentials = deletingScope === 'selected';
  const isDeletingFilteredCredentials = deletingScope === 'filtered';
  const disableDeleteActions = disabled || isRefreshing || isDeletingCredentials;
  const currentFilterHttpStatus = getCredentialFilterHttpStatus(credentialFilter);
  const statusFilterCounts = [...credentialFilterCounts.statusCounts];
  if (
    currentFilterHttpStatus !== null &&
    !statusFilterCounts.some((item) => item.status === currentFilterHttpStatus)
  ) {
    statusFilterCounts.push({ status: currentFilterHttpStatus, count: 0 });
    statusFilterCounts.sort((left, right) => left.status - right.status);
  }
  const credentialFilterOptions: Array<{
    value: CredentialValidityFilter;
    label: string;
    count: number;
  }> = [
    {
      value: 'all' as const,
      label: t('quota_management.credential_filter_all'),
      count: credentialFilterCounts.all,
    },
    ...statusFilterCounts.map((item) => ({
      value: `${HTTP_STATUS_FILTER_PREFIX}${item.status}` as CredentialValidityFilter,
      label: t('quota_management.credential_filter_http_status', { status: item.status }),
      count: item.count,
    })),
  ];

  return (
    <Card
      title={titleNode}
      extra={
        <div className={styles.headerActions}>
          <div className={styles.viewModeToggle}>
            <Button
              variant="secondary"
              size="sm"
              className={`${styles.viewModeButton} ${
                effectiveViewMode === 'paged' ? styles.viewModeButtonActive : ''
              }`}
              onClick={() => setViewMode('paged')}
            >
              {t('auth_files.view_mode_paged')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={`${styles.viewModeButton} ${
                effectiveViewMode === 'all' ? styles.viewModeButtonActive : ''
              }`}
              onClick={() => {
                if (credentialFilteredFiles.length > MAX_SHOW_ALL_THRESHOLD) {
                  setShowTooManyWarning(true);
                } else {
                  setViewMode('all');
                }
              }}
            >
              {t('auth_files.view_mode_all')}
            </Button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className={styles.refreshAllButton}
            onClick={() => handleRefresh('page')}
            disabled={disabled || isRefreshing || pageItems.length === 0}
            loading={isRefreshingCurrentPage}
            title={t('quota_management.refresh_current_page_credentials')}
            aria-label={t('quota_management.refresh_current_page_credentials')}
          >
            {!isRefreshingCurrentPage && <IconRefreshCw size={16} />}
            {t('quota_management.refresh_current_page_credentials')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className={styles.refreshAllButton}
            onClick={() => handleRefresh('all')}
            disabled={disabled || isRefreshing || filteredFiles.length === 0}
            loading={isRefreshingAllCredentials}
            title={t('quota_management.refresh_all_credentials')}
            aria-label={t('quota_management.refresh_all_credentials')}
          >
            {!isRefreshingAllCredentials && <IconRefreshCw size={16} />}
            {t('quota_management.refresh_all_credentials')}
          </Button>
        </div>
      }
    >
      {filteredFiles.length === 0 ? (
        <EmptyState
          title={t(`${config.i18nPrefix}.empty_title`)}
          description={t(`${config.i18nPrefix}.empty_desc`)}
        />
      ) : (
        <>
          <div className={styles.credentialToolbar}>
            <div
              className={styles.credentialFilterToggle}
              role="group"
              aria-label={t('quota_management.credential_filter_label')}
            >
              {credentialFilterOptions.map((option) => (
                <Button
                  key={option.value}
                  variant="secondary"
                  size="sm"
                  className={`${styles.credentialFilterButton} ${
                    credentialFilter === option.value ? styles.credentialFilterButtonActive : ''
                  }`}
                  onClick={() => setCredentialFilter(option.value)}
                >
                  {option.label}
                  <span className={styles.credentialFilterCount}>{option.count}</span>
                </Button>
              ))}
            </div>

            <div className={styles.credentialSelectionActions}>
              {selectedCredentialCount > 0 && (
                <span className={styles.selectedCredentialsBadge}>
                  {t('quota_management.selected_credentials_count', {
                    count: selectedCredentialCount,
                  })}
                </span>
              )}
              <Button
                variant="secondary"
                size="sm"
                className={styles.selectionActionButton}
                onClick={selectCurrentPageCredentials}
                disabled={selectablePageItems.length === 0 || isDeletingCredentials}
              >
                <IconCheck size={16} />
                {t('quota_management.select_current_page_credentials')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={styles.selectionActionButton}
                onClick={clearSelectedCredentials}
                disabled={selectedCredentialCount === 0 || isDeletingCredentials}
              >
                <IconX size={16} />
                {t('quota_management.clear_selected_credentials')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                className={styles.selectionDangerButton}
                onClick={deleteSelectedCredentials}
                disabled={disableDeleteActions || selectedCredentialCount === 0}
                loading={isDeletingSelectedCredentials}
              >
                {!isDeletingSelectedCredentials && <IconTrash2 size={16} />}
                {t('quota_management.delete_selected_credentials')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                className={styles.selectionDangerButton}
                onClick={deleteFilteredCredentials}
                disabled={disableDeleteActions || filteredDeletableFiles.length === 0}
                loading={isDeletingFilteredCredentials}
              >
                {!isDeletingFilteredCredentials && <IconTrash2 size={16} />}
                {t('quota_management.delete_filtered_credentials')}
              </Button>
            </div>
          </div>

          {credentialFilteredFiles.length === 0 ? (
            <EmptyState
              title={t('quota_management.filter_empty_title')}
              description={t('quota_management.filter_empty_desc')}
            />
          ) : (
            <>
              <div ref={gridRef} className={config.gridClassName}>
                {pageItems.map((item) => (
                  <QuotaCard
                    key={item.name}
                    item={item}
                    quota={quota[item.name]}
                    resolvedTheme={resolvedTheme}
                    i18nPrefix={config.i18nPrefix}
                    cardIdleMessageKey={config.cardIdleMessageKey}
                    cardClassName={config.cardClassName}
                    defaultType={config.type}
                    canRefresh={!disabled && !item.disabled}
                    onRefresh={() => void refreshQuotaForFile(item)}
                    selectable={!isRuntimeOnlyAuthFile(item)}
                    selected={selectedFileNames.has(item.name)}
                    onToggleSelect={toggleCredentialSelection}
                    renderQuotaItems={config.renderQuotaItems}
                  />
                ))}
              </div>
              {credentialFilteredFiles.length > pageSize && effectiveViewMode === 'paged' && (
                <div className={styles.pagination}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={goToPrev}
                    disabled={currentPage <= 1}
                  >
                    {t('auth_files.pagination_prev')}
                  </Button>
                  <div className={styles.pageInfo}>
                    {t('auth_files.pagination_info', {
                      current: currentPage,
                      total: totalPages,
                      count: credentialFilteredFiles.length,
                    })}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={goToNext}
                    disabled={currentPage >= totalPages}
                  >
                    {t('auth_files.pagination_next')}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
      {showTooManyWarning && (
        <div className={styles.warningOverlay} onClick={() => setShowTooManyWarning(false)}>
          <div className={styles.warningModal} onClick={(e) => e.stopPropagation()}>
            <p>{t('auth_files.too_many_files_warning')}</p>
            <Button variant="primary" size="sm" onClick={() => setShowTooManyWarning(false)}>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Generic quota section component.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getStatusFromError } from '@/utils/quota';
import { QuotaCard } from './QuotaCard';
import type { QuotaStatusState } from './QuotaCard';
import { useQuotaLoader } from './useQuotaLoader';
import type { QuotaConfig } from './quotaConfigs';
import { useGridColumns } from './useGridColumns';
import { IconRefreshCw } from '@/components/ui/icons';
import styles from '@/pages/QuotaPage.module.scss';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

type ViewMode = 'paged' | 'all';
type QuotaRefreshScope = 'page' | 'all';
type CredentialValidityStatus = 'valid' | 'invalid';

interface CredentialRefreshProgress {
  valid: number;
  invalid: number;
  statuses: Record<string, CredentialValidityStatus>;
}

const MAX_ITEMS_PER_PAGE = 25;
const MAX_SHOW_ALL_THRESHOLD = 30;
const EMPTY_CREDENTIAL_VALIDITY_CACHE: Record<string, CredentialValidityStatus> = {};

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
    setLoading
  };
};

interface QuotaSectionProps<TState extends QuotaStatusState, TData> {
  config: QuotaConfig<TState, TData>;
  files: AuthFileItem[];
  loading: boolean;
  disabled: boolean;
}

export function QuotaSection<TState extends QuotaStatusState, TData>({
  config,
  files,
  loading,
  disabled
}: QuotaSectionProps<TState, TData>) {
  const { t } = useTranslation();
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;

  /* Removed useRef */
  const [columns, gridRef] = useGridColumns(380); // Min card width 380px matches SCSS
  const [viewMode, setViewMode] = useState<ViewMode>('paged');
  const [showTooManyWarning, setShowTooManyWarning] = useState(false);

  const filteredFiles = useMemo(() => files.filter((file) => config.filterFn(file)), [
    files,
    config
  ]);
  const showAllAllowed = filteredFiles.length <= MAX_SHOW_ALL_THRESHOLD;
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
    setLoading
  } = useQuotaPagination(filteredFiles);

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
      setPageSize(Math.max(1, filteredFiles.length));
    } else {
      // Paged mode: 3 rows * columns, capped to avoid oversized pages.
      setPageSize(Math.min(columns * 3, MAX_ITEMS_PER_PAGE));
    }
  }, [effectiveViewMode, columns, filteredFiles.length, setPageSize]);

  const { quota, loadQuota } = useQuotaLoader(config);
  const credentialValidityCache = useQuotaStore(
    (state) => state.credentialValidityCache[config.type] ?? EMPTY_CREDENTIAL_VALIDITY_CACHE
  );
  const setCredentialValidityCache = useQuotaStore(
    (state) => state.setCredentialValidityCache
  );
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
          valid:
            prev.valid + (status === 'valid' ? 1 : 0) - (previousStatus === 'valid' ? 1 : 0),
          invalid:
            prev.invalid + (status === 'invalid' ? 1 : 0) - (previousStatus === 'invalid' ? 1 : 0),
          statuses: {
            ...prev.statuses,
            [fileName]: status
          }
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
          quotaStatus === 'success'
            ? 'valid'
            : quotaStatus === 'error'
              ? 'invalid'
              : cachedStatus;

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
    setCredentialValidityCache
  ]);

  const cachedCredentialCounts = useMemo(
    () =>
      filteredFiles.reduce(
        (counts, file) => {
          const credentialStatus = credentialValidityCache[file.name];
          if (credentialStatus === 'valid') {
            counts.validCredentialCount += 1;
          } else if (credentialStatus === 'invalid') {
            counts.invalidCredentialCount += 1;
          }
          return counts;
        },
        { validCredentialCount: 0, invalidCredentialCount: 0 }
      ),
    [credentialValidityCache, filteredFiles]
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
        pendingScope === 'all' ? updateAllCredentialRefreshProgress : undefined
    });
  }, [
    loading,
    pendingQuotaRefreshScope,
    filteredFiles,
    pageItems,
    loadQuota,
    setLoading,
    updateAllCredentialRefreshProgress
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
        [file.name]: config.buildLoadingState()
      }));

      try {
        const data = await config.fetchQuota(file, t);
        setQuota((prev) => ({
          ...prev,
          [file.name]: config.buildSuccessState(data)
        }));
        showNotification(t('auth_files.quota_refresh_success', { name: file.name }), 'success');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status = getStatusFromError(err);
        setQuota((prev) => ({
          ...prev,
          [file.name]: config.buildErrorState(message, status)
        }));
        showNotification(
          t('auth_files.quota_refresh_failed', { name: file.name, message }),
          'error'
        );
      }
    },
    [config, disabled, quota, setQuota, showNotification, t]
  );

  const titleNode = (
    <div className={styles.titleWrapper}>
      <span>{t(`${config.i18nPrefix}.title`)}</span>
      {filteredFiles.length > 0 && (
        <span className={styles.countBadge}>
          {filteredFiles.length}
        </span>
      )}
      {filteredFiles.length > 0 && (
        <span
          className={`${styles.credentialCountBadge} ${
            invalidCredentialCount > 0 ? styles.credentialCountBadgeWarning : ''
          }`}
          title={t('quota_management.valid_credentials_count', {
            valid: validCredentialCount,
            total: filteredFiles.length
          })}
          aria-label={t('quota_management.valid_credentials_count', {
            valid: validCredentialCount,
            total: filteredFiles.length
          })}
        >
          {validCredentialCount}/{filteredFiles.length}
        </span>
      )}
    </div>
  );

  const isRefreshing = sectionLoading || loading;
  const isRefreshingCurrentPage =
    (loading && pendingQuotaRefreshScope === 'page') ||
    (sectionLoading && loadingScope === 'page');
  const isRefreshingAllCredentials =
    (loading && pendingQuotaRefreshScope === 'all') ||
    (sectionLoading && loadingScope === 'all');

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
                if (filteredFiles.length > MAX_SHOW_ALL_THRESHOLD) {
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
                renderQuotaItems={config.renderQuotaItems}
              />
            ))}
          </div>
          {filteredFiles.length > pageSize && effectiveViewMode === 'paged' && (
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
                  count: filteredFiles.length
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

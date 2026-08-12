"use client";

import {
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Search,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type WorkspaceTab<T extends string> = {
  badge?: ReactNode;
  controls?: string;
  icon?: LucideIcon;
  id: T;
  label: ReactNode;
  tabId?: string;
};

export function WorkspaceTabs<T extends string>({
  actions,
  activeTab,
  ariaLabel,
  idPrefix,
  nextLabel,
  onChange,
  previousLabel,
  scrollable = false,
  tabs,
  variant = "panel",
}: {
  actions?: ReactNode;
  activeTab: T;
  ariaLabel: string;
  idPrefix: string;
  nextLabel?: string;
  onChange: (tab: T) => void;
  previousLabel?: string;
  scrollable?: boolean;
  tabs: readonly WorkspaceTab<T>[];
  variant?: "application" | "panel";
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ left: false, right: false });

  const updateScroll = useCallback(() => {
    const element = viewport.current;
    if (!element || !scrollable) return;
    const maximum = element.scrollWidth - element.clientWidth;
    setScroll({
      left: element.scrollLeft > 1,
      right: element.scrollLeft < maximum - 1,
    });
  }, [scrollable]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !scrollable) return;
    const observer = new ResizeObserver(updateScroll);
    observer.observe(element);
    element.addEventListener("scroll", updateScroll, { passive: true });
    const frame = requestAnimationFrame(updateScroll);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("scroll", updateScroll);
    };
  }, [scrollable, updateScroll]);

  const select = (tab: T) => {
    onChange(tab);
    requestAnimationFrame(() => {
      const tabId = tabs.find((entry) => entry.id === tab)?.tabId;
      document.getElementById(tabId ?? `${idPrefix}-${tab}-tab`)?.focus();
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    select(tabs[nextIndex].id);
  };

  const scrollTabs = (direction: -1 | 1) => {
    const element = viewport.current;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(80, element.clientWidth * 0.75),
      behavior: "auto",
    });
  };

  const tabButtons = tabs.map(({ badge, controls, icon: Icon, id, label, tabId }, index) => {
    const selected = activeTab === id;
    return (
      <button
        aria-controls={controls}
        aria-selected={selected}
        className={variant === "application"
          ? "app-navigation-tab"
          : `relative flex h-full shrink-0 items-center gap-1.5 px-2.5 text-[10px] font-semibold outline-none after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 focus-visible:bg-[#d7e7e4] ${selected ? "text-[#0c766e] after:bg-[#0c766e]" : "text-[#718488] after:bg-transparent hover:text-[#29484c]"}`}
        data-active={variant === "application" ? (selected ? "true" : "false") : undefined}
        id={tabId ?? `${idPrefix}-${id}-tab`}
        key={id}
        onClick={() => onChange(id)}
        onKeyDown={(event) => handleKeyDown(event, index)}
        role="tab"
        tabIndex={selected ? 0 : -1}
        type="button"
      >
        {Icon && <Icon aria-hidden="true" size={12} />}
        <span>{label}</span>
        {badge}
      </button>
    );
  });

  if (variant === "application") {
    return (
      <nav aria-label={ariaLabel} className="app-navigation">
        <div role="tablist">{tabButtons}</div>
      </nav>
    );
  }

  return (
    <div className="flex min-w-0 border-b border-[#cbd8d9] bg-[#f8faf9]">
      <div className="relative min-w-0 flex-1">
        {scroll.left && (
          <button
            aria-label={previousLabel}
            className="absolute inset-y-0 left-0 z-10 flex w-7 items-center justify-center bg-[#f8faf9] text-[#63777b] outline-none hover:bg-[#dfecea] hover:text-[#164f4a] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
            onClick={() => scrollTabs(-1)}
            title={previousLabel}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={15} />
          </button>
        )}
        <div
          aria-label={ariaLabel}
          className="minimal-scrollbar min-w-0 overflow-x-auto"
          ref={viewport}
          role="tablist"
        >
          <div className="flex h-[33px] min-w-max items-stretch gap-0.5 px-1">{tabButtons}</div>
        </div>
        {scroll.right && (
          <button
            aria-label={nextLabel}
            className="absolute inset-y-0 right-0 z-10 flex w-7 items-center justify-center bg-[#f8faf9] text-[#63777b] outline-none hover:bg-[#dfecea] hover:text-[#164f4a] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
            onClick={() => scrollTabs(1)}
            title={nextLabel}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={15} />
          </button>
        )}
      </div>
      {actions && <div className="flex h-[33px] shrink-0 items-center px-1">{actions}</div>}
    </div>
  );
}

export type WorkspaceNavigationItem<T extends string> = {
  controls: string;
  icon: LucideIcon;
  id: T;
  label: string;
  tabId: string;
};

export function WorkspaceNavigation<T extends string>({
  activeItem,
  ariaLabel,
  bordered = false,
  collapsed = false,
  footerItems = [],
  headerAction,
  id,
  items,
  onChange,
  title,
}: {
  activeItem: T;
  ariaLabel: string;
  bordered?: boolean;
  collapsed?: boolean;
  footerItems?: readonly WorkspaceNavigationItem<T>[];
  headerAction?: ReactNode;
  id: string;
  items: readonly WorkspaceNavigationItem<T>[];
  onChange: (item: T) => void;
  title: ReactNode;
}) {
  const navigationItems = [...items, ...footerItems];
  const select = (item: T) => {
    onChange(item);
    requestAnimationFrame(() => {
      document.getElementById(navigationItems.find((entry) => entry.id === item)?.tabId ?? "")?.focus();
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % navigationItems.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + navigationItems.length) % navigationItems.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = navigationItems.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    select(navigationItems[nextIndex].id);
  };

  const renderItem = (
    { controls, icon: Icon, id: itemId, label, tabId }: WorkspaceNavigationItem<T>,
    index: number,
  ) => {
    const selected = activeItem === itemId;
    return (
      <div className="group relative" key={itemId}>
        <button
          aria-controls={controls}
          aria-label={collapsed ? label : undefined}
          aria-selected={selected}
          className={`relative flex h-10 w-full items-center text-left text-xs outline-none before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${collapsed ? "justify-center" : "gap-2.5 px-3"} ${selected ? "bg-[#d9e9e6] font-semibold text-[#164f4a] before:bg-[#0c766e]" : "text-[#526b70] before:bg-transparent hover:bg-[#e3ecea] hover:text-[#28484d]"}`}
          id={tabId}
          onClick={() => onChange(itemId)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          role="tab"
          tabIndex={selected ? 0 : -1}
          title={collapsed ? label : undefined}
          type="button"
        >
          <Icon aria-hidden="true" className="shrink-0" size={15} strokeWidth={1.8} />
          {!collapsed && <span className="truncate">{label}</span>}
        </button>
        {collapsed && (
          <span className="pointer-events-none absolute left-[42px] top-1/2 z-30 -translate-y-1/2 whitespace-nowrap border border-[#9fb3b5] bg-[#203337] px-2 py-1 text-[10px] text-white opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 motion-reduce:transition-none" role="tooltip">
            {label}
          </span>
        )}
      </div>
    );
  };

  return (
    <nav
      aria-label={ariaLabel}
      className={`grid min-h-0 grid-rows-[40px_minmax(0,1fr)] bg-[#edf3f2] ${bordered ? "border-r border-[#b9c7ca]" : ""}`}
      id={id}
    >
      <div className={`flex h-10 items-center border-b border-[#cbd8d9] ${collapsed ? "justify-center" : "justify-between px-3"}`}>
        {!collapsed && <span className="truncate text-[10px] font-semibold uppercase text-[#6a7e82]">{title}</span>}
        {headerAction}
      </div>
      <div aria-orientation="vertical" className="flex min-h-0 flex-col" role="tablist">
        {items.map(renderItem)}
        {footerItems.length > 0 && (
          <div className="mt-auto border-t border-[#cbd8d9] pt-1">
            {footerItems.map((item, index) => renderItem(item, items.length + index))}
          </div>
        )}
      </div>
    </nav>
  );
}

export function PanelHeader({
  actions,
  icon: Icon,
  metadata,
  monospace = false,
  title,
  titleId,
  variant = "compact",
}: {
  actions?: ReactNode;
  icon?: LucideIcon;
  metadata?: ReactNode;
  monospace?: boolean;
  title: ReactNode;
  titleId?: string;
  variant?: "compact" | "workspace";
}) {
  if (variant === "workspace") {
    return (
      <header className="flex min-h-14 items-center justify-between gap-4 border-b border-[#cbd8d9] bg-white px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-[#193d43]" id={titleId}>{title}</h2>
          {metadata && <p className="mt-0.5 text-[10px] text-[#718488]">{metadata}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
    );
  }

  return (
    <header className="flex h-[34px] min-w-0 items-center justify-between gap-3 border-b border-[#cbd8d9] bg-[#edf3f2] px-3">
      <div className="flex min-w-0 items-center gap-2">
        {Icon && <Icon aria-hidden="true" className="shrink-0 text-[#537277]" size={14} strokeWidth={1.8} />}
        <h2 className={`truncate text-[11px] font-semibold text-[#24434a] ${monospace ? "font-mono" : ""}`} id={titleId}>{title}</h2>
        {metadata && <span className="shrink-0 text-[9px] text-[#718488]">{metadata}</span>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function SearchField({
  compact = false,
  label,
  onChange,
  value,
  width = "w-full",
}: {
  compact?: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
  width?: string;
}) {
  return (
    <label className={`flex items-center gap-1.5 border border-[#c6d4d4] bg-white px-2 focus-within:border-[#0c766e] focus-within:ring-1 focus-within:ring-[#0c766e] ${compact ? "h-6" : "h-7"} ${width}`}>
      <Search aria-hidden="true" className="shrink-0 text-[#718488]" size={13} />
      <span className="sr-only">{label}</span>
      <input
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent text-[11px] text-[#294247] outline-none placeholder:text-[#829397]"
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        type="search"
        value={value}
      />
    </label>
  );
}

export function WorkspaceListPane({
  children,
  countLabel,
  empty,
  emptyLabel,
  headerActions,
  id,
  loading = false,
  loadingLabel,
  onQueryChange,
  query,
  searchLabel,
  title,
}: {
  children: ReactNode;
  countLabel: ReactNode;
  empty: boolean;
  emptyLabel: string;
  headerActions?: ReactNode;
  id: string;
  loading?: boolean;
  loadingLabel?: string;
  onQueryChange: (query: string) => void;
  query: string;
  searchLabel: string;
  title: ReactNode;
}) {
  return (
    <aside className="grid min-h-0 grid-rows-[34px_38px_1fr] bg-[#f8faf9]" id={id}>
      <PanelHeader
        actions={headerActions ?? <span className="font-mono text-[9px] text-[#718488]">{countLabel}</span>}
        title={title}
      />
      <div className="border-b border-[#d9e3e3] p-1.5">
        <SearchField compact label={searchLabel} onChange={onQueryChange} value={query} />
      </div>
      <div className="minimal-scrollbar min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] text-[#718488]">
            <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />
            {loadingLabel}
          </div>
        ) : empty ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[#718488]">
            {emptyLabel}
          </div>
        ) : children}
      </div>
    </aside>
  );
}

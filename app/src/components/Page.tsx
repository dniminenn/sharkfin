// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The page language every tab shares. Sections are type, not boxes: a
// title, a line under it, the controls. Borders belong to things you press.
import { cn } from "@/lib/utils";

/** Title and one line of guidance, with the page's controls on the right. */
export function PageHeader({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Section({
  title,
  hint,
  actions,
  className,
  children,
}: {
  title?: React.ReactNode;
  hint?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {!title && hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      {children}
    </section>
  );
}

/** A few exclusive choices, one control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex rounded-lg bg-muted p-[3px] text-sm">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(v)}
          data-on={value === v}
          className="rounded-md px-3 py-1 text-muted-foreground transition-colors disabled:opacity-50 data-[on=true]:bg-background data-[on=true]:text-foreground data-[on=true]:shadow-sm"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** One choice among many: quiet until picked, filled when it is. */
export function Chip({
  on,
  className,
  ...props
}: React.ComponentProps<"button"> & { on?: boolean }) {
  return (
    <button
      type="button"
      data-on={on}
      className={cn(
        "rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-50 data-[on=true]:bg-primary data-[on=true]:text-primary-foreground data-[on=true]:hover:bg-primary",
        className,
      )}
      {...props}
    />
  );
}

/** A quiet surface for grouped controls: a tint, never a border. */
export function Strip({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-xl bg-muted/40 p-3", className)} {...props} />;
}

/** A moment that needs an answer, tinted with the accent. */
export function Banner({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-xl bg-primary/10 px-4 py-3 text-sm motion-safe:animate-in motion-safe:fade-in",
        className,
      )}
      {...props}
    />
  );
}

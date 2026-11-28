import * as React from 'react'
import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  )
}

interface LoadingSkeletonProps {
  rows?: number
  className?: string
  label?: string
}

/** 轻量列表/卡片骨架态，减少首屏加载时的布局抖动。 */
function LoadingSkeleton({
  rows = 3,
  className,
  label = '加载中...',
}: LoadingSkeletonProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn('space-y-3 rounded-lg border bg-card p-4', className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, idx) => (
        <div key={idx} className="flex items-center gap-3">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24 shrink-0" />
          <Skeleton className="h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  )
}

export { Skeleton, LoadingSkeleton }

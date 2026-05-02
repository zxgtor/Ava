import React from 'react'

interface Props {
  size?: number
  className?: string
}

export function Logo({ size = 24, className = '' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <radialGradient id="shell-grad" cx="30%" cy="30%" r="70%" fx="30%" fy="30%">
          <stop offset="0%" stopColor="white" stopOpacity="0.4" />
          <stop offset="50%" stopColor="white" stopOpacity="0.1" />
          <stop offset="100%" stopColor="white" stopOpacity="0.05" />
        </radialGradient>
        
        <radialGradient id="core-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#E0F2FE" stopOpacity="0.8" />
          <stop offset="60%" stopColor="#3B82F6" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#A855F7" stopOpacity="0" />
        </radialGradient>

        <linearGradient id="facet-1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="white" stopOpacity="0.3" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>

        <filter id="soft-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      <circle cx="50%" cy="50%" r="46" stroke="white" strokeOpacity="0.15" strokeWidth="0.5" />
      <circle cx="50%" cy="50%" r="40" fill="url(#core-glow)" filter="url(#soft-glow)" />
      <path d="M50 15 L80 50 L50 85 L20 50 Z" fill="url(#facet-1)" opacity="0.4" />
      <path d="M50 10 L65 50 L50 90 L35 50 Z" fill="white" opacity="0.15" />
      <path d="M15 50 L50 35 L85 50 L50 65 Z" fill="white" opacity="0.1" />
      <circle cx="50%" cy="50%" r="45" fill="url(#shell-grad)" />
      <path d="M30 20 Q 50 10 70 20" stroke="white" strokeOpacity="0.6" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

export function SyntaxBrand({ className = '' }: { className?: string }) {
  return (
    <div className={`ava-brand-mark ${className}`} aria-label="Ava">
      <span className="ava-brand-brace">{'{'}</span>
      <span className="ava-brand-name">ava</span>
      <span className="ava-brand-dot" />
      <span className="ava-brand-brace">{'}'}</span>
    </div>
  )
}

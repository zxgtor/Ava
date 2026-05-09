import React from 'react'
import { Server, AlertTriangle, HelpCircle, CheckCircle } from 'lucide-react'
import type { ProjectAnalysis } from '../types'

interface Props {
  analysis: ProjectAnalysis
  onQuickReply?: (text: string) => void
}

export function ProjectAnalysisCard({ analysis, onQuickReply }: Props) {
  return (
    <div className="w-full max-w-2xl bg-surface-1 border border-border/60 rounded-xl overflow-hidden shadow-sm my-4">
      <div className="px-5 py-4 border-b border-border/40 bg-surface-2/30 flex items-center gap-3">
        <Server size={18} className="text-accent" />
        <h3 className="font-semibold text-text text-[15px]">Pre-Flight Analysis</h3>
      </div>
      
      <div className="p-5 flex flex-col gap-5">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-text-3 mb-2 flex items-center gap-2">
            Goal Summary
          </h4>
          <p className="text-sm text-text-2 leading-relaxed">
            {analysis.projectSummary}
          </p>
        </div>

        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-text-3 mb-2 flex items-center gap-2">
            <CheckCircle size={14} className="text-emerald-500" />
            Detected Architecture
          </h4>
          <p className="text-sm text-text-2 leading-relaxed bg-black/20 p-3 rounded-lg font-mono text-[13px] border border-border/30">
            {analysis.architecture}
          </p>
        </div>

        {analysis.unknowns && analysis.unknowns.length > 0 && (
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-text-3 mb-3 flex items-center gap-2">
              <HelpCircle size={14} className="text-amber-500" />
              Unknowns & Clarifications
            </h4>
            <ul className="flex flex-col gap-3">
              {analysis.unknowns.map((u, i) => (
                <li key={i} className="text-sm text-text-2 flex flex-col gap-2 bg-amber-500/5 p-3 rounded-xl border border-amber-500/10">
                  <div className="flex items-start gap-2">
                    <div className={`mt-1 w-2 h-2 rounded-full ${u.importance === 'high' ? 'bg-amber-500 animate-pulse' : 'bg-amber-500/40'}`} />
                    <span className="font-medium text-text-1">{u.question}</span>
                  </div>
                  {u.options && u.options.length > 0 && (
                    <div className="flex flex-wrap gap-2 ml-4 mt-1">
                      {u.options.map((opt, oi) => (
                        <button
                          key={oi}
                          onClick={() => onQuickReply?.(opt)}
                          className="px-3 py-1 text-[11px] font-semibold bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 border border-amber-500/20 rounded-full transition-all cursor-pointer"
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {analysis.risks && analysis.risks.length > 0 && (
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-text-3 mb-3 flex items-center gap-2">
              <AlertTriangle size={14} className="text-error" />
              Potential Risks & Mitigations
            </h4>
            <ul className="flex flex-col gap-3">
              {analysis.risks.map((r, i) => (
                <li 
                  key={i} 
                  className="text-[13px] flex flex-col gap-2 bg-error/5 p-3 rounded-xl border border-error/10"
                >
                  <div className="flex items-start gap-2">
                    <div className={`mt-1 w-2 h-2 rounded-full ${r.impact === 'high' ? 'bg-error animate-pulse' : r.impact === 'medium' ? 'bg-error/60' : 'bg-error/30'}`} />
                    <span className="font-bold text-text-1">{r.risk}</span>
                  </div>
                  <div className="ml-4 text-[12px] text-text-3 italic">
                    Mitigation: {r.mitigation}
                  </div>
                  <button 
                    onClick={() => onQuickReply?.(`Regarding the risk: "${r.risk}", how will you implement the mitigation: "${r.mitigation}"?`)}
                    className="ml-4 mt-1 self-start text-[11px] font-medium text-error/70 hover:text-error transition-colors underline decoration-error/20"
                  >
                    Discuss this risk
                  </button>
                </li>
              ))}
            </ul>
            {onQuickReply && (
              <button 
                onClick={() => onQuickReply?.("How can we mitigate the potential risks listed above? Please provide specific technical suggestions.")}
                className="mt-4 w-full py-2.5 text-[12px] font-bold text-error bg-error/5 hover:bg-error/10 border border-error/20 rounded-xl transition-all flex items-center justify-center gap-2 shadow-sm cursor-pointer"
              >
                <AlertTriangle size={14} />
                HELP ME MITIGATE ALL RISKS
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

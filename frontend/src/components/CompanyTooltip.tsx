import React, { useState } from 'react';
import { Tooltip } from './Tooltip';

export function CompanyTooltip({ ticker, children }: { ticker: string, children: React.ReactNode }) {
  const [summary, setSummary] = useState<string>('Loading company summary...');
  const [hasFetched, setHasFetched] = useState(false);

  const handleMouseEnter = () => {
    if (!hasFetched) {
      setHasFetched(true);
      fetch(`http://localhost:5000/api/company/summary/${ticker}`)
        .then(res => res.json())
        .then(data => {
            if (data.summary) {
                // Truncate if too long to prevent massive tooltips
                const truncated = data.summary.length > 300 ? data.summary.substring(0, 300) + '...' : data.summary;
                setSummary(truncated);
            } else {
                setSummary('No summary available.');
            }
        })
        .catch(() => setSummary('Failed to load summary.'));
    }
  };

  return (
    <div onMouseEnter={handleMouseEnter} className="inline-block">
      <Tooltip content={<div className="max-w-xs text-left text-sm leading-relaxed">{summary}</div>} enabled={true}>
        {children}
      </Tooltip>
    </div>
  );
}

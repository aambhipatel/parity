export function formatCurrency(value: number): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  });
  return value < 0 ? `-${formatted}` : formatted;
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const clean = dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00`;
  const d = new Date(clean);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function getMonthOptions(count = 12): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    options.push({ value, label });
  }
  return options;
}

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export interface ParsedDescription {
  title: string;
  symbol?: string;
  optionLabel?: string;
  qty?: string;
  price?: string;
  fees?: string;
  isOption: boolean;
}

/**
 * Parses the Schwab-formatted description stored by data_import.py.
 * Format: "Sym: SYMBOL MM/DD/YYYY STRIKE C | Contract description | Qty: QUANTITY | Price: PRICE | Fees: FEES"
 */
export function parseDescription(raw: string): ParsedDescription {
  if (!raw) return { title: 'N/A', isOption: false };

  const parts = raw.split(' | ').map((p) => p.trim());
  const result: ParsedDescription = { title: '', isOption: false };

  let accumulatedFees = 0;

  for (const part of parts) {
    if (part.startsWith('Sym:')) {
      const symStr = part.replace('Sym:', '').trim();
      // Match Schwab option format: SYMBOL MM/DD/YYYY STRIKE C
      const optMatch = symStr.match(/^([A-Z]+)\s+(\d{2}\/\d{2}\/\d{4})\s+([\d.]+)\s+([CP])$/);
      if (optMatch) {
        result.symbol = optMatch[1];
        // Convert MM/DD/YYYY → YYYY-MM-DD for valid Date parsing
        const [mo, da, yr] = optMatch[2].split('/');
        const expDate = new Date(`${yr}-${mo}-${da}T00:00:00`);
        const expStr = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const optType = optMatch[4] === 'C' ? 'Call' : 'Put';
        result.optionLabel = `${optMatch[1]} $${optMatch[3]} ${optType} · ${expStr}`;
        result.isOption = true;
      } else {
        result.symbol = symStr;
      }
    } else if (part.startsWith('Qty:')) {
      result.qty = part.replace('Qty:', '').trim();
    } else if (part.startsWith('Price:')) {
      result.price = part.replace('Price:', '').trim();
    } else if (part.startsWith('Fees:')) {
      const feeVal = parseFloat(part.replace('Fees:', '').replace('$', '').trim()) || 0;
      accumulatedFees += feeVal;
      result.fees = `$${accumulatedFees.toFixed(2)}`;
    } else if (!result.title) {
      result.title = part;
    }
  }

  if (!result.title) {
    result.title = result.optionLabel || result.symbol || raw;
  }

  return result;
}

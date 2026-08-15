import { AssetTicker } from '@/config/assets';
import formatAmount from './format-amount';
import getDisplaySymbol from './get-display-symbol';

const EIGHT_DECIMALS = 8;
const EIGHT_DECIMAL_TOKENS = new Set(['btc', 'xaut']);

const formatTokenAmount = (amount: number, token: AssetTicker, includeSymbol: boolean = true) => {
  const symbol = getDisplaySymbol(token);

  if (amount === 0) return `0.00${includeSymbol ? ` ${symbol}` : ''}`;

  const tokenKey = (token ?? '').toString().toLowerCase();
  const useEightDecimals = EIGHT_DECIMAL_TOKENS.has(tokenKey);
  const decimals = useEightDecimals
    ? EIGHT_DECIMALS
    : Math.max(Math.ceil(Math.abs(Math.log10(amount))), 2);

  const formattedAmount = formatAmount(amount, {
    minimumFractionDigits: useEightDecimals ? EIGHT_DECIMALS : 0,
    maximumFractionDigits: decimals,
  });

  return `${formattedAmount}${includeSymbol ? ` ${symbol}` : ''}`;
};

export default formatTokenAmount;

import type { TableConfig } from '../config';
import { hashDiffStrategy } from './hashDiff';
import { modifiedAtStrategy } from './modifiedAt';
import { pkWindowStrategy } from './pkWindow';
import { rowversionStrategy } from './rowversion';
import type { Strategy } from './types';

export const strategies: Record<TableConfig['strategy'], Strategy> = {
  rowversion: rowversionStrategy,
  modifiedAt: modifiedAtStrategy,
  pkWindow: pkWindowStrategy,
  hashDiff: hashDiffStrategy
};

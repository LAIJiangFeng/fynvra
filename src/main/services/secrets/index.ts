export {
  collectAppSecrets,
  collectKnownSecrets,
  type KnownSecretSources,
  MIN_SECRET_LENGTH,
  registerSecretSource,
} from './known';
export {
  findLocalInfo,
  type LocalInfoContext,
  REDACTED_SECRET,
  redactSecrets,
  type SecretScanResult,
  sanitizeLocalInfo,
  scanSecrets,
} from './scan';

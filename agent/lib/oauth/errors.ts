export class OAuthStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class OAuthConfigurationError extends OAuthStorageError {}

export class OAuthCredentialsUnavailableError extends OAuthStorageError {}

export class OAuthCredentialMissingError extends OAuthStorageError {}

export class OAuthCredentialConflictError extends OAuthStorageError {}

export class OAuthCredentialInvalidError extends OAuthStorageError {}

export class OAuthDecryptionError extends OAuthStorageError {}

export class OAuthDatabaseError extends OAuthStorageError {}

export class OAuthRefreshError extends OAuthStorageError {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(`OAuth token refresh failed (${code}).`, options);
    this.code = code;
  }
}

// Types mirroring the barakoCMS API surface. Hand-written for v0.1; a future version may generate
// these from the API's OpenAPI document so they can't drift.

/** Content lifecycle status. Matches the API's numeric enum. */
export enum ContentStatus {
  Draft = 0,
  Published = 1,
  Archived = 2,
}

/** A single content entry. `data` is the typed-per-content-type field bag. */
export interface Content {
  id: string;
  contentType: string;
  data: Record<string, unknown>;
  status: ContentStatus;
  version: number;
  sensitivity?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** A page of results from a list endpoint. */
export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface FieldDefinition {
  name: string;
  displayName: string;
  type: string;
  isRequired: boolean;
  defaultValue?: unknown;
  validationRules?: Record<string, unknown>;
  sensitivity?: number;
  visibleToRoles?: string[];
  mask?: number;
}

export interface ContentTypeDefinition {
  id?: string;
  name: string;
  displayName: string;
  description?: string;
  fields: FieldDefinition[];
  createdAt?: string;
  updatedAt?: string;
}

/** The token pair returned by login / refresh / switch-tenant. */
export interface AuthTokens {
  token: string;
  expiry: string;
  refreshToken: string;
  refreshTokenExpiry: string;
  /** True when the password was right but the device needs approval: no tokens issued, an OTP was
   *  emailed. Only appears on login for device-trust deployments. */
  deviceApprovalRequired?: boolean;
}

export interface TenantSummary {
  slug: string;
  name: string;
  logoUrl?: string | null;
  branding?: Record<string, string>;
}

export interface CreateContentInput {
  contentType: string;
  data: Record<string, unknown>;
  status?: ContentStatus;
  sensitivity?: number;
}

export interface UpdateContentInput {
  data: Record<string, unknown>;
  status?: ContentStatus;
}

export interface ListContentQuery {
  contentType?: string;
  page?: number;
  pageSize?: number;
  status?: ContentStatus;
}

export interface ContentVersion {
  version: number;
  status: ContentStatus;
  updatedAt?: string;
  data?: Record<string, unknown>;
}

// --- Public delivery (anonymous, published-only) -------------------------------

/** A published entry from the public delivery API. Only public fields are present. */
export interface PublicContent {
  id: string;
  contentType: string;
  slug?: string | null;
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface MenuItem {
  label: string;
  url: string;
  openInNewTab?: boolean;
  children?: MenuItem[];
}

/** A navigation menu from the public delivery API. */
export interface PublicMenu {
  slug: string;
  name: string;
  items: MenuItem[];
}

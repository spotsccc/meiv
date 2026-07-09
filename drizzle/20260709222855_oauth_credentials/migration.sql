CREATE TABLE "oauth_credentials" (
	"id" text PRIMARY KEY,
	"encrypted_payload" jsonb NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

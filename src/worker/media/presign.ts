import { AwsClient } from "aws4fetch";
import type { SupportedImageMimeType } from "@/worker/media/constants";
import { PRESIGNED_PUT_TTL_SECONDS } from "@/worker/media/constants";

export interface R2SigningConfiguration {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PresignedPutRequest {
  url: string;
  method: "PUT";
  headers: {
    "content-type": SupportedImageMimeType;
    "x-amz-checksum-sha256": string;
  };
  expiresInSeconds: number;
}

function awsDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split("/").map(encodeURIComponent).join("/");
}

export async function presignR2Put(
  configuration: R2SigningConfiguration,
  objectKey: string,
  contentType: SupportedImageMimeType,
  checksumSha256: string,
  now = new Date(),
): Promise<PresignedPutRequest> {
  const endpoint = new URL(
    `https://${configuration.accountId}.r2.cloudflarestorage.com`,
  );
  endpoint.pathname = `/${encodeURIComponent(configuration.bucketName)}/${encodeObjectKey(objectKey)}`;
  endpoint.searchParams.set(
    "X-Amz-Expires",
    String(PRESIGNED_PUT_TTL_SECONDS),
  );

  const headers = new Headers({
    "content-type": contentType,
    "x-amz-checksum-sha256": checksumSha256,
  });
  const client = new AwsClient({
    accessKeyId: configuration.accessKeyId,
    secretAccessKey: configuration.secretAccessKey,
    service: "s3",
    region: "auto",
    retries: 0,
  });
  const signed = await client.sign(endpoint, {
    method: "PUT",
    headers,
    aws: {
      signQuery: true,
      allHeaders: true,
      datetime: awsDate(now),
    },
  });

  return {
    url: signed.url,
    method: "PUT",
    headers: {
      "content-type": contentType,
      "x-amz-checksum-sha256": checksumSha256,
    },
    expiresInSeconds: PRESIGNED_PUT_TTL_SECONDS,
  };
}

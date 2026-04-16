import { klaviyo } from "./klaviyo.js";

export interface KlaviyoAccount {
  organizationName: string;
  websiteUrl: string;
  address: {
    street: string;
    city: string;
    region: string;
    zip: string;
    country: string;
  };
}

export async function fetchAccount(apiKey: string): Promise<KlaviyoAccount> {
  const body = await klaviyo("/accounts/", apiKey);
  const acct = body.data[0];
  const ci = acct.attributes.contact_information;
  const addr = ci.street_address;
  return {
    organizationName: ci.organization_name || "",
    websiteUrl: ci.website_url || "",
    address: {
      street: [addr.address1, addr.address2].filter(Boolean).join(", "),
      city: addr.city || "",
      region: addr.region || "",
      zip: addr.zip || "",
      country: addr.country || "",
    },
  };
}

export function formatAddress(acct: KlaviyoAccount): string {
  const a = acct.address;
  const cityStateZip = [a.city, a.region].filter(Boolean).join(", ") + (a.zip ? ` ${a.zip}` : "");
  return [a.street, cityStateZip, a.country].filter(Boolean).join(", ");
}

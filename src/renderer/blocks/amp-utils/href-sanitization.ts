export type MailtoUrl = `mailto:${string}`;

export function sanitizedHref(href?: string | URL): string | undefined {
  if (!href) {
    return undefined;
  }
  href = href.toString().trim();

  const isAmpVariable = href.startsWith("{{");
  if (isAmpVariable) {
    return href;
  }

  const isAlreadySanitized = href.startsWith("https://");
  if (isAlreadySanitized) {
    return href;
  }

  const isInsecure = href.startsWith("http://");
  if (isInsecure) {
    return href.replace("http://", "https://");
  }

  const noPrefix = href.replace(/^.*?:/, "");

  const isEmail = href.includes("@");
  if (isEmail) {
    return `mailto:${noPrefix}`;
  }

  if (isPhoneNumber(noPrefix)) {
    return `tel:${noPrefix}`;
  }

  const invalidProtocol = href.includes("://");
  if (invalidProtocol) {
    return undefined;
  }

  return `https://${href}`;
}

export function allHrefsSanitized(html: string) {
  const hrefRegex = /href=(["'])(.*?)\1/g;
  const firstPass = html.replaceAll(hrefRegex, (_: string, quote: string, href: string) => {
    const sanitized = sanitizedHref(href);
    return sanitized ? `href=${quote}${sanitized}${quote}` : "";
  });
  const secondPass = firstPass.replaceAll(/href=(["'])\1/g, "");
  return secondPass.replaceAll(/<a(?![^>]*\bhref=)[^>]*>(.*)<\/a>/g, "$1");
}

function isPhoneNumber(href: string): boolean {
  return /^\+?[0-9\-() ]+$/.test(href);
}

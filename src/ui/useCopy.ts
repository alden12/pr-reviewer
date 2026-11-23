import { useState } from "react";

/**
 * Copy text to the clipboard, and whether it just was (for a second and a half, for the button to say so). A refused
 * or missing clipboard (an insecure origin, a denied permission) leaves it false rather than throwing.
 */
export function useCopy(): [copied: boolean, copy: (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };
  return [copied, copy];
}

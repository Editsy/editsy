"use client";
import { useEditsy } from "editsy/react";
import globalContent from "@/content/global";

export function Footer() {
  const global = useEditsy(globalContent, "content/global.ts");
  return (
    <footer>
      <p>{global.footer.tagline}</p>
      <p>
        <a href={`mailto:${global.footer.email}`}>{global.footer.email}</a>
        {" · "}
        <a href={global.footer.website}>editsy.dev</a>
      </p>
      {/*
        f.html fields render exactly what was saved, unsanitized - editsy
        does not clean this up for you. Fine for a single trusted
        maintainer's own content (this demo); if you have multiple editors,
        sanitize the value yourself (e.g. DOMPurify) before rendering it,
        the same way you would for any dangerouslySetInnerHTML.
      */}
      <div
        className="fine-print"
        dangerouslySetInnerHTML={{ __html: global.footer.finePrint }}
      />
    </footer>
  );
}

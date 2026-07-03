"use client";
// A client component so useEditsy can live-preview edits: inside the editsy
// editor's iframe, drafts stream in as you type; on the real site the hook
// returns the imported content untouched.
import { Markdown, useEditsy } from "editsy/react";
import homeContent from "@/content/home";
import postsContent from "@/content/posts";
// JSON content files work too: an object is a page, an array is a collection.
import settingsContent from "@/content/settings.json";

export default function Home() {
  const home = useEditsy(homeContent, "content/home.ts");
  const posts = useEditsy(postsContent, "content/posts.ts");
  const settings = useEditsy(settingsContent, "content/settings.json");

  return (
    <main>
      {settings.showAnnouncement && <p className="announcement">{settings.announcement}</p>}
      <section className="hero">
        <h1>{home.hero.heading}</h1>
        <p>{home.hero.subheading}</p>
        <a className="cta" href={home.hero.cta.href}>
          {home.hero.cta.label}
        </a>
      </section>

      <section>
        <h2>{home.about.heading}</h2>
        <Markdown source={home.about.body} />
      </section>

      <section id="posts">
        <h2>{settings.postsHeading}</h2>
        {posts.length === 0 && <p>No posts yet.</p>}
        {posts.map((post, i) => (
          <article key={i} className="post">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="post-image" src={post.image} alt="" width={72} height={72} />
            <h3>{post.title}</h3>
            <p className="meta">
              {post.date}
              {post.tags.length > 0 && <> · {post.tags.join(", ")}</>}
              {post.published ? "" : " · draft"}
            </p>
            <Markdown source={post.summary} />
          </article>
        ))}
      </section>
    </main>
  );
}

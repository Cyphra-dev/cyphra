"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PostStatusSchema } from "@/cyphra.zod";
import { useTRPC } from "@/trpc/client";

export default function Home() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"" | (typeof PostStatusSchema.options)[number]>("");

  const users = useQuery(trpc.user.list.queryOptions());
  const posts = useQuery(trpc.post.list.queryOptions({ status: status || undefined, take: 20 }));

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.post.pathKey() });
  const createUser = useMutation(
    trpc.user.create.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.user.pathKey() }),
    }),
  );
  const createPost = useMutation(trpc.post.create.mutationOptions({ onSuccess: refresh }));
  const publish = useMutation(trpc.post.update.mutationOptions({ onSuccess: refresh }));
  const remove = useMutation(trpc.post.delete.mutationOptions({ onSuccess: refresh }));

  // `issues` comes from the errorFormatter: the same messages as the schema's validation rules.
  const issues = createPost.error?.data?.issues ?? createUser.error?.data?.issues ?? [];

  return (
    <main>
      <h1>Posts</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          createUser.mutate({ name: String(form.get("name")), email: String(form.get("email")) });
        }}
      >
        <input name="name" placeholder="Name" />
        <input name="email" placeholder="Email" />
        <button>Add user</button>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          createPost.mutate({
            authorId: String(form.get("authorId")),
            title: String(form.get("title")),
            body: String(form.get("body")),
          });
        }}
      >
        <select name="authorId">
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <input name="title" placeholder="Title" />
        <textarea name="body" placeholder="Body" />
        <button disabled={!users.data?.length}>Add post</button>
      </form>

      {issues.length > 0 && (
        <ul role="alert">
          {issues.map((i) => (
            <li key={i.path.join(".")}>
              {i.path.join(".")}: {i.message}
            </li>
          ))}
        </ul>
      )}

      <label>
        Status{" "}
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">All</option>
          {PostStatusSchema.options.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>

      <p>{posts.data ? `${posts.data.total} posts` : "Loading…"}</p>
      <ul>
        {posts.data?.items.map((post) => (
          <li key={post.id}>
            <strong>{post.title}</strong> by {post.author.name} · {post.status} ·{" "}
            {post.createdAt.toLocaleDateString()}{" "}
            {post.status === "DRAFT" && (
              <button
                onClick={() => publish.mutate({ id: post.id, data: { status: "PUBLISHED" } })}
              >
                Publish
              </button>
            )}
            <button onClick={() => remove.mutate({ id: post.id })}>Delete</button>
          </li>
        ))}
      </ul>
    </main>
  );
}

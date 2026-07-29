import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const backendReady = Boolean(url && key);
export const supabase = backendReady ? createClient(url, key) : null;

export async function uploadProfileAvatar(userId, imageDataUrl) {
  if (!supabase || !imageDataUrl) return "";
  const response = await fetch(imageDataUrl);
  const blob = await response.blob();
  const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
  const path = `${userId}/profile-${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from("post-media").upload(path, blob, { contentType: blob.type, upsert: false });
  if (error) throw error;
  return supabase.storage.from("post-media").getPublicUrl(path).data.publicUrl;
}

export async function uploadPostMedia(userId, files) {
  if (!supabase || !files.length) return [];
  const uploads = files.map(async file => {
    const extension = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "bin";
    const path = `${userId}/${crypto.randomUUID()}.${extension}`;
    const { error } = await supabase.storage.from("post-media").upload(path, file, {
      contentType: file.type,
      upsert: false
    });
    if (error) throw error;
    return { url: supabase.storage.from("post-media").getPublicUrl(path).data.publicUrl, type: file.type };
  });
  return Promise.all(uploads);
}

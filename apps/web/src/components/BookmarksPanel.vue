<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import type { Favorite } from "@campus/contracts";
import type { Transport } from "../lib/transport";
import { safeError } from "../lib/errors";
const props = defineProps<{ transport: Transport; schoolId: string | null }>();
const emit = defineEmits<{ open: [favorite: Favorite] }>();
const allSchools = ref(false), items = ref<Favorite[]>([]), cursor = ref<string | null>(null), busy = ref(false), error = ref("");
let epoch = 0, active = true;
async function load(more = false) {
  const ticket = ++epoch; busy.value = true; error.value = "";
  if (!more) { items.value = []; cursor.value = null; }
  try {
    const page = await props.transport.call("favorites.list", { ...(!allSchools.value && props.schoolId ? { schoolId: props.schoolId } : {}), ...(more && cursor.value ? { cursor: cursor.value } : {}) });
    if (active && ticket === epoch) { items.value = more ? [...items.value, ...page.items] : page.items; cursor.value = page.nextCursor; }
  } catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
  finally { if (active && ticket === epoch) busy.value = false; }
}
async function remove(item: Favorite) {
  busy.value = true; error.value = "";
  try { await props.transport.call("favorites.set", { schoolId: item.schoolId, itemId: item.itemId, saved: false }); if (active) await load(); }
  catch (caught) { if (active) error.value = safeError(caught); }
  finally { if (active) busy.value = false; }
}
watch([allSchools, () => props.schoolId], () => void load());
onMounted(() => void load());
onUnmounted(() => { active = false; epoch++; items.value = []; });
</script>
<template>
  <section class="feature-surface" aria-labelledby="favorites-title">
    <div class="feature-heading"><div><h1 id="favorites-title">我的收藏</h1><p>保存到本人账号，切换学校也不会丢失。</p></div><button class="text-button" :disabled="busy" @click="load()">刷新收藏</button></div>
    <label class="inline-option"><input v-model="allSchools" type="checkbox" />查看全部学校收藏</label>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <p v-if="busy && !items.length" role="status">正在读取收藏…</p>
    <div v-else-if="!items.length" class="empty-state"><h3>还没有收藏</h3><p>打开一条公告，点击“收藏公告”即可保存。</p></div>
    <article v-for="item in items" :key="`${item.schoolId}/${item.itemId}`" class="favorite-row">
      <div><span class="muted small">{{ item.schoolName }}</span><h2><button class="favorite-open" :disabled="!item.notice || busy" @click="emit('open', item)">{{ item.notice?.title || "公告已不可读取" }}</button></h2><p>{{ item.notice?.summary || (item.notice ? item.notice.sourceName : "公告已下架、超过保留期或权限变化。收藏记录仍保留，可手动移除。") }}</p></div>
      <button class="text-button" :disabled="busy" @click="remove(item)">移除收藏</button>
    </article>
    <button v-if="cursor" class="load-more" :disabled="busy" @click="load(true)">加载更多收藏</button>
  </section>
</template>

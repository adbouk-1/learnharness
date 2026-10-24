import { modelCatalog, refreshPickerCatalogs } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). The static
 * catalogs are stable within a pi-ai version; the Ollama Cloud catalog is
 * live, so the handler first awaits its stale-gated refresh (network,
 * bounded at 20 s, never throws; skipped while fresh or keyless).
 */
export async function GET() {
	await refreshPickerCatalogs();
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}

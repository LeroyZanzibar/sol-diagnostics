import { getBucketBinding, getDatabaseBinding } from "../../../../db/binding";
import { DEPOT_CLEANUP_ID, deleteDepotPerformanceStep, depotCleanupPreview } from "../../../../db/depot-performance-cleanup";
const headers = {"Cache-Control":"private, no-store"};
export async function GET() {
  try { return Response.json(await depotCleanupPreview(getDatabaseBinding(),getBucketBinding()),{headers}); }
  catch (error) { return Response.json({error:error instanceof Error?error.message:"Unable to inspect cleanup."},{status:500,headers}); }
}
export async function DELETE(request: Request) {
  try {
    const payload = await request.json();
    if (payload.confirm !== DEPOT_CLEANUP_ID) return Response.json({error:"Exact cleanup confirmation is required."},{status:400,headers});
    return Response.json(await deleteDepotPerformanceStep(getDatabaseBinding(),getBucketBinding()),{headers});
  } catch (error) { return Response.json({error:error instanceof Error?error.message:"Cleanup paused; retry safely."},{status:409,headers}); }
}

import {ChartViewError, createChartView, listChartViews} from '../../../db/chart-views';

export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 32 * 1024;
const respond = (data: unknown, status = 200) => Response.json(data, {
  status, headers: {'Cache-Control': 'private, no-store'},
});
function failure(error: unknown) {
  if (error instanceof ChartViewError) return respond({error: error.message}, error.status);
  return respond({error: 'Unable to access saved chart views. Read saved views before retrying an uncertain save.'}, 500);
}

async function readInput(request: Request): Promise<unknown> {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => {});
    throw new ChartViewError('Chart view requests cannot exceed 32 KiB.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ChartViewError('A JSON request body is required.');
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let size = 0, text = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new ChartViewError('Chart view requests cannot exceed 32 KiB.');
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ChartViewError) throw error;
    throw new ChartViewError('Send a valid UTF-8 JSON request.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function GET() {
  try {return respond({views: await listChartViews()});}
  catch (error) {return failure(error);}
}

export async function POST(request: Request) {
  try {return respond({view: createChartView(await readInput(request))}, 201);}
  catch (error) {return failure(error);}
}

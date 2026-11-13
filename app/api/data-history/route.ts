// Retained analysis snapshots remain readable; new imports replace the site file.
export async function GET(){return Response.json({history:null,mode:"single-file"});}
export async function POST(){return Response.json({error:"Uploads now replace the site file automatically. Refresh the upload page; no append/replace preview is needed."},{status:410});}

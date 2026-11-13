import { defaultTheme, isThemeId } from "../../themes";
import { normalizeIssueVisibility, issueVisibilityInputError } from "../../issue-visibility";
import { getDatabaseBinding } from "../../../db/binding";

type UserSettingsPayload={firstName?:unknown;lastName?:unknown;title?:unknown;minimumIssueLossKwh?:unknown;theme?:unknown;issueVisibility?:unknown};
type UserSettingsRow={first_name:string;last_name:string;title:string;minimum_issue_loss_kwh:string;theme:string;issue_visibility?:string};

const USER_ID="primary-user";
const defaults={firstName:"Local",lastName:"Analyst",title:"Asset Manager",minimumIssueLossKwh:"",theme:defaultTheme};
const selectSettings="SELECT first_name, last_name, title, minimum_issue_loss_kwh, theme, issue_visibility FROM user_settings WHERE id = ? LIMIT 1";
const headers={"Cache-Control":"private, no-store"};

function decoded(row:UserSettingsRow|null){
  let visibility:unknown;
  try{visibility=JSON.parse(row?.issue_visibility||"{}");}catch{visibility={};}
  return {...(row?{firstName:row.first_name,lastName:row.last_name,title:row.title,minimumIssueLossKwh:row.minimum_issue_loss_kwh,theme:isThemeId(row.theme)?row.theme:defaultTheme}:defaults),issueVisibility:normalizeIssueVisibility(visibility)};
}
const invalid=(error:string)=>Response.json({error},{status:400});
const isObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

export async function GET(){
  try{const row=await getDatabaseBinding().prepare(selectSettings).bind(USER_ID).first<UserSettingsRow>();return Response.json({user:decoded(row)},{headers});}
  catch(error){return Response.json({error:error instanceof Error?error.message:"Unable to load user settings."},{status:500});}
}

export async function PUT(request:Request){
  try{
    const input:unknown=await request.json().catch(()=>null);if(!isObject(input))return invalid("Provide valid user settings.");
    const payload=input as UserSettingsPayload;const firstName=String(payload.firstName||"").trim();const lastName=String(payload.lastName||"").trim();const title=String(payload.title||"").trim();const rawThreshold=String(payload.minimumIssueLossKwh??"").trim();
    const theme=payload.theme ?? defaultTheme;
    if(!isThemeId(theme))return invalid("Select a supported theme.");
    if(!firstName||!lastName)return invalid("First name and last name are required.");
    if(firstName.length>80||lastName.length>80||title.length>120)return invalid("One or more profile fields are too long.");
    if(rawThreshold){const threshold=Number(rawThreshold);if(!Number.isFinite(threshold)||threshold<0)return invalid("The issue loss threshold must be blank or a non-negative kWh value.");}
    const supplied=Object.prototype.hasOwnProperty.call(payload,'issueVisibility');
    if(supplied){const error=issueVisibilityInputError(payload.issueVisibility);if(error)return invalid(error);}
    const visibility=JSON.stringify(normalizeIssueVisibility(payload.issueVisibility));
    const minimumIssueLossKwh=rawThreshold?String(Number(rawThreshold)):"";const now=new Date().toISOString();
    const db=getDatabaseBinding();
    // An older profile form omitting visibility must not reset another saved preference.
    await db.prepare("INSERT INTO user_settings (id, first_name, last_name, title, minimum_issue_loss_kwh, theme, issue_visibility, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, title = excluded.title, minimum_issue_loss_kwh = excluded.minimum_issue_loss_kwh, theme = excluded.theme, issue_visibility = CASE WHEN ? THEN excluded.issue_visibility ELSE user_settings.issue_visibility END, updated_at = excluded.updated_at").bind(USER_ID,firstName,lastName,title,minimumIssueLossKwh,theme,visibility,now,supplied?1:0).run();
    return Response.json({user:decoded(await db.prepare(selectSettings).bind(USER_ID).first<UserSettingsRow>())},{headers});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"Unable to save user settings."},{status:500});}
}

/** Save display preferences without modifying the profile, theme or analysis threshold. */
export async function PATCH(request:Request){
  try{
    const payload:unknown=await request.json().catch(()=>null);
    if(!isObject(payload)||Object.keys(payload).some(key=>key!=='issueVisibility'))return invalid("This update accepts issue visibility preferences only.");
    const error=issueVisibilityInputError(payload.issueVisibility);if(error)return invalid(error);
    const visibility=JSON.stringify(normalizeIssueVisibility(payload.issueVisibility)),now=new Date().toISOString(),db=getDatabaseBinding();
    await db.prepare("INSERT INTO user_settings (id, first_name, last_name, title, minimum_issue_loss_kwh, theme, issue_visibility, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET issue_visibility = excluded.issue_visibility, updated_at = excluded.updated_at").bind(USER_ID,defaults.firstName,defaults.lastName,defaults.title,defaults.minimumIssueLossKwh,defaults.theme,visibility,now).run();
    return Response.json({user:decoded(await db.prepare(selectSettings).bind(USER_ID).first<UserSettingsRow>())},{headers});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"Unable to save issue visibility."},{status:500});}
}

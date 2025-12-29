// response.ts
import { corsHeaders } from "./cors.ts";
const response = (body, statusCode) => {
  return new Response(
    JSON.stringify({
      body,
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
      status: statusCode,
    }
  );
};
export default response;

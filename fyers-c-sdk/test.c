// #include <stdio.h>
// #include "fyers_api.h"
// #include "fyers_session.h"
// #include <cjson/cJSON.h>

// void fy_generate_token(fyers_session_t* session, const char* auth_code) {
//     fyers_session_set_authcode(session, auth_code);

//     fyers_response_t* response = generate_token(session);
//     if (!response) {
//         fprintf(stderr, "Failed to generate token\n");
//         fyers_session_destroy(session);
//         fyers_cleanup();
//         return;
//     }
//     printf("response: %s\n", response->data);
// }


// int main() {
//     const char* client_id = "BGKT3357Z1-100";
//     const char* redirect_uri = "https://trade.fyers.in/api-login/redirect-uri/index.html";
//     const char* secret_key = "QCZNDOERIE";
//     const char* auth_code = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBfaWQiOiJCR0tUMzM1N1oxIiwidXVpZCI6ImJiNzE5OGExYTBjYjQ1OWY4MGU3YjU4NTExN2Q5YWEwIiwiaXBBZGRyIjoiIiwibm9uY2UiOiIiLCJzY29wZSI6IiIsImRpc3BsYXlfbmFtZSI6IkZBSzcyMzU2Iiwib21zIjoiSzEiLCJoc21fa2V5IjoiOWVkNGVkZTllYTY2NzNjZjdiMDcxOGFhYzJmNjEyZTcxMzY0NmQ4MDdjZTZjMTUyMTc3YzAzNjciLCJpc0RkcGlFbmFibGVkIjoiTiIsImlzTXRmRW5hYmxlZCI6Ik4iLCJhdWQiOiJbXCJkOjFcIixcImQ6MlwiLFwieDowXCIsXCJ4OjFcIl0iLCJleHAiOjE3ODg5MjIyNzIsImlhdCI6MTc4ODg5MjI3MiwiaXNzIjoiYXBpLmxvZ2luLmZ5ZXJzLmluIiwibmJmIjoxNzg4ODkyMjcyLCJzdWIiOiJhdXRoX2NvZGUifQ.bTN1KB4cagXe-hVXOGcn67KSifkwV2Sz8NIdLPBMW0w";

//     fyers_session_t* session = fyers_session_create(
//         client_id,
//         redirect_uri,
//         secret_key
//     );

//     if (!session) {
//         fprintf(stderr, "Failed to create session\n");
//         return 0;
//     }

//     fy_generate_token(session, auth_code);
//     return 0;
// }







// #include <stdio.h>
// #include "fyers_api.h"
// #include "fyers_session.h"
// #include <cjson/cJSON.h>


// void fy_generate_authcode(fyers_session_t* session) {
//     if (generate_authcode(session) != FYERS_OK) {
//         fprintf(stderr, "Failed to generate auth URL\n");
//     }
// }

// int main() {
//     const char* client_id = "BGKT3357Z1-100";
//     const char* redirect_uri = "https://google.com";
//     const char* secret_key = "QCZNDOERIE";

//     fyers_session_t* session = fyers_session_create(
//         client_id,
//         redirect_uri,
//         secret_key
//     );

//     if (!session) {
//         fprintf(stderr, "Failed to create session\n");
//         return 0;
//     }

//     fy_generate_authcode(session);

//     fyers_session_destroy(session);
//     fyers_cleanup();
//     return 0;
// }




// eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBfaWQiOiJCR0tUMzM1N1oxIiwidXVpZCI6IjdlNTYwZTBmODZiZTQ5MzE4ZGJkZDZlODFmNTFhMmNmIiwiaXBBZGRyIjoiIiwibm9uY2UiOiIiLCJzY29wZSI6IiIsImRpc3BsYXlfbmFtZSI6IkZBSzcyMzU2Iiwib21zIjoiSzEiLCJoc21fa2V5IjoiZGU4NDM2Y2E1N2U5Zjk0ZWUzNmVkZmZhNzkxNjlkYzdmZjY2Zjg1ZTJmNGE3YWFmZGJlOWI3N2IiLCJpc0RkcGlFbmFibGVkIjoiTiIsImlzTXRmRW5hYmxlZCI6Ik4iLCJhdWQiOiJbXCJkOjFcIixcImQ6MlwiLFwieDowXCIsXCJ4OjFcIl0iLCJleHAiOjE3ODg5NzE2MTksImlhdCI6MTc4ODk0MTYxOSwiaXNzIjoiYXBpLmxvZ2luLmZ5ZXJzLmluIiwibmJmIjoxNzg4OTQxNjE5LCJzdWIiOiJhdXRoX2NvZGUifQ.oNppNRSB_slOToZohySyIG6mmq6rkOc5a0xTEMyvZAQ





#include <stdio.h>
#include "fyers_api.h"
#include "fyers_session.h"
#include <cjson/cJSON.h>

void fy_generate_token(fyers_session_t* session, const char* auth_code) {
    fyers_session_set_authcode(session, auth_code);

    fyers_response_t* response = generate_token(session);
    if (!response) {
        fprintf(stderr, "Failed to generate token\n");
        fyers_session_destroy(session);
        fyers_cleanup();
        return;
    }
    printf("response: %s\n", response->data);
}


int main() {
    const char* auth_code = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBfaWQiOiJCR0tUMzM1N1oxIiwidXVpZCI6IjdlNTYwZTBmODZiZTQ5MzE4ZGJkZDZlODFmNTFhMmNmIiwiaXBBZGRyIjoiIiwibm9uY2UiOiIiLCJzY29wZSI6IiIsImRpc3BsYXlfbmFtZSI6IkZBSzcyMzU2Iiwib21zIjoiSzEiLCJoc21fa2V5IjoiZGU4NDM2Y2E1N2U5Zjk0ZWUzNmVkZmZhNzkxNjlkYzdmZjY2Zjg1ZTJmNGE3YWFmZGJlOWI3N2IiLCJpc0RkcGlFbmFibGVkIjoiTiIsImlzTXRmRW5hYmxlZCI6Ik4iLCJhdWQiOiJbXCJkOjFcIixcImQ6MlwiLFwieDowXCIsXCJ4OjFcIl0iLCJleHAiOjE3ODg5NzE2MTksImlhdCI6MTc4ODk0MTYxOSwiaXNzIjoiYXBpLmxvZ2luLmZ5ZXJzLmluIiwibmJmIjoxNzg4OTQxNjE5LCJzdWIiOiJhdXRoX2NvZGUifQ.oNppNRSB_slOToZohySyIG6mmq6rkOc5a0xTEMyvZAQ";
    const char* client_id = "BGKT3357Z1-100";
    const char* redirect_uri = "https://google.com";
    const char* secret_key = "QCZNDOERIE";


    fyers_session_t* session = fyers_session_create(
        client_id,
        redirect_uri,
        secret_key
    );

    if (!session) {
        fprintf(stderr, "Failed to create session\n");
        return 0;
    }

    fy_generate_token(session, auth_code);
    return 0;
}


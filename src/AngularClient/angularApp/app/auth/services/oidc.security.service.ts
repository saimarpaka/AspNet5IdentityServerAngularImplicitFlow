﻿import { Injectable } from '@angular/core';
import { Http, Response, Headers } from '@angular/http';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/catch';
import { Observable } from 'rxjs/Rx';
import { Router } from '@angular/router';
import { AuthConfiguration } from '../auth.configuration';
import { OidcSecurityValidation } from './oidc.security.validation';
import { OidcSecurityCheckSession } from './oidc.security.check-session';
import { OidcSecuritySilentRenew } from './oidc.security.silent-renew';
import { OidcSecurityUserService } from './oidc.security.user-service';
import { OidcSecurityCommon } from './oidc.security.common';
import { JwtKeys } from './jwtkeys';

@Injectable()
export class OidcSecurityService {

    checkSessionChanged: boolean;
    isAuthorized: boolean;

    private actionUrl: string;
    private headers: Headers;
    private oidcSecurityValidation: OidcSecurityValidation;
    private errorMessage: string;
    private jwtKeys: JwtKeys;

    constructor(private http: Http,
        private authConfiguration: AuthConfiguration,
        private router: Router,
        private oidcSecurityCheckSession: OidcSecurityCheckSession,
        private oidcSecuritySilentRenew: OidcSecuritySilentRenew,
        private oidcSecurityUserService: OidcSecurityUserService,
        private oidcSecurityCommon: OidcSecurityCommon
    ) {

        this.actionUrl = authConfiguration.server + 'api/DataEventRecords/';
        this.oidcSecurityValidation = new OidcSecurityValidation();

        this.headers = new Headers();
        this.headers.append('Content-Type', 'application/json');
        this.headers.append('Accept', 'application/json');

        if (this.oidcSecurityCommon.retrieve('_isAuthorized') !== '') {
            this.isAuthorized = this.oidcSecurityCommon.retrieve('_isAuthorized');
        }

        this.oidcSecurityCheckSession.onCheckSessionChanged.subscribe(() => { this.onCheckSessionChanged(); });
    }

    getToken(): any {
        return this.oidcSecurityCommon.getToken();
    }

    authorize() {
        this.resetAuthorizationData();

        console.log('BEGIN Authorize, no auth data');

        let nonce = 'N' + Math.random() + '' + Date.now();
        let state = Date.now() + '' + Math.random();

        this.oidcSecurityCommon.store('authStateControl', state);
        this.oidcSecurityCommon.store('authNonce', nonce);
        console.log('AuthorizedController created. adding myautostate: ' + this.oidcSecurityCommon.retrieve('authStateControl'));

        let url = this.createAuthorizeUrl(nonce, state);
        window.location.href = url;
    }

    authorizedCallback() {
        console.log('BEGIN AuthorizedCallback, no auth data');
        this.resetAuthorizationData();

        let hash = window.location.hash.substr(1);

        let result: any = hash.split('&').reduce(function (result: any, item: string) {
            let parts = item.split('=');
            result[parts[0]] = parts[1];
            return result;
        }, {});

        console.log(result);
        console.log('AuthorizedCallback created, begin token validation');

        let token = '';
        let id_token = '';
        let authResponseIsValid = false;

        this.getSigningKeys()
            .subscribe(jwtKeys => {
                this.jwtKeys = jwtKeys;

                if (!result.error) {

                    // validate state
                    if (this.oidcSecurityValidation.validateStateFromHashCallback(result.state, this.oidcSecurityCommon.retrieve('authStateControl'))) {
                        token = result.access_token;
                        id_token = result.id_token;
                        let decoded: any;
                        let headerDecoded;
                        decoded = this.oidcSecurityValidation.getPayloadFromToken(id_token, false);
                        headerDecoded = this.oidcSecurityValidation.getHeaderFromToken(id_token, false);

                        // validate jwt signature
                        if (this.oidcSecurityValidation.validate_signature_id_token(id_token, this.jwtKeys)) {
                            // validate nonce
                            if (this.oidcSecurityValidation.validate_id_token_nonce(decoded, this.oidcSecurityCommon.retrieve('authNonce'))) {
                                // validate iss
                                if (this.oidcSecurityValidation.validate_id_token_iss(decoded, this.authConfiguration.iss)) {
                                    // validate aud
                                    if (this.oidcSecurityValidation.validate_id_token_aud(decoded, this.authConfiguration.client_id)) {
                                        // valiadate at_hash and access_token
                                        if (this.oidcSecurityValidation.validate_id_token_at_hash(token, decoded.at_hash) || !token) {
                                            this.oidcSecurityCommon.store('authNonce', '');
                                            this.oidcSecurityCommon.store('authStateControl', '');

                                            authResponseIsValid = true;
                                            console.log('AuthorizedCallback state, nonce, iss, aud, signature validated, returning token');
                                        } else {
                                            console.log('AuthorizedCallback incorrect aud');
                                        }
                                    } else {
                                        console.log('AuthorizedCallback incorrect aud');
                                    }
                                } else {
                                    console.log('AuthorizedCallback incorrect iss');
                                }
                            } else {
                                console.log('AuthorizedCallback incorrect nonce');
                            }
                        } else {
                            console.log('AuthorizedCallback incorrect Signature id_token');
                        }
                    } else {
                        console.log('AuthorizedCallback incorrect state');
                    }
                }

                if (authResponseIsValid) {
                    this.setAuthorizationData(token, id_token);
                    this.oidcSecurityUserService.initUserData();
                    console.log(this.oidcSecurityCommon.retrieve('authorizationData'));

                    if (this.authConfiguration.start_checksession) {
                        this.oidcSecurityCheckSession.init().then(() => {
                            this.oidcSecurityCheckSession.pollServerSession(result.session_state, 'angularclient');
                        });
                    }

                    if (this.authConfiguration.silent_renew) {
                        this.oidcSecuritySilentRenew.initRenew();
                    }

                    this.runTokenValidatation();

                    this.router.navigate([this.authConfiguration.startupRoute]);
                } else {
                    this.resetAuthorizationData();
                    this.router.navigate(['/Unauthorized']);
                }
            });
    }

    logoff() {
        // /connect/endsession?id_token_hint=...&post_logout_redirect_uri=https://myapp.com
        console.log('BEGIN Authorize, no auth data');

        let authorizationEndsessionUrl = this.authConfiguration.logoutEndSession_url;

        let id_token_hint = this.oidcSecurityCommon.retrieve('authorizationDataIdToken');
        let post_logout_redirect_uri = this.authConfiguration.post_logout_redirect_uri;

        let url =
            authorizationEndsessionUrl + '?' +
            'id_token_hint=' + encodeURI(id_token_hint) + '&' +
            'post_logout_redirect_uri=' + encodeURI(post_logout_redirect_uri);

        this.resetAuthorizationData();

        if (this.authConfiguration.start_checksession && this.checkSessionChanged) {
            console.log('only local login cleaned up, server session has changed');
        } else {
            window.location.href = url;
        }
    }

    refreshSession() {
        console.log('BEGIN refresh session Authorize');

        let nonce = 'N' + Math.random() + '' + Date.now();
        let state = Date.now() + '' + Math.random();

        this.oidcSecurityCommon.store('authStateControl', state);
        this.oidcSecurityCommon.store('authNonce', nonce);
        console.log('RefreshSession created. adding myautostate: ' + this.oidcSecurityCommon.retrieve('authStateControl'));

        let url = this.createAuthorizeUrl(nonce, state);

        this.oidcSecuritySilentRenew.startRenew(url);
    }

    private setAuthorizationData(token: any, id_token: any) {
        if (this.oidcSecurityCommon.retrieve('authorizationData') !== '') {
            this.oidcSecurityCommon.store('authorizationData', '');
        }

        console.log(token);
        console.log(id_token);
        console.log('storing to storage, getting the roles');
        this.oidcSecurityCommon.store('authorizationData', token);
        this.oidcSecurityCommon.store('authorizationDataIdToken', id_token);
        this.isAuthorized = true;
        this.oidcSecurityCommon.store('_isAuthorized', true);
    }

    private createAuthorizeUrl(nonce: string, state: string): string {

        let authorizationUrl = this.authConfiguration.server + '/connect/authorize';
        let client_id = this.authConfiguration.client_id;
        let redirect_uri = this.authConfiguration.redirect_url;
        let response_type = this.authConfiguration.response_type;
        let scope = this.authConfiguration.scope;

        let url =
            authorizationUrl + '?' +
            'response_type=' + encodeURI(response_type) + '&' +
            'client_id=' + encodeURI(client_id) + '&' +
            'redirect_uri=' + encodeURI(redirect_uri) + '&' +
            'scope=' + encodeURI(scope) + '&' +
            'nonce=' + encodeURI(nonce) + '&' +
            'state=' + encodeURI(state);

        return url;

    }

    private resetAuthorizationData() {
        this.isAuthorized = false;
        this.oidcSecurityCommon.resetStorageData();
        this.checkSessionChanged = false;
    }

    handleError(error: any) {
        console.log(error);
        if (error.status == 403) {
            this.router.navigate(['/Forbidden']);
        } else if (error.status == 401) {
            this.resetAuthorizationData();
            this.router.navigate(['/Unauthorized']);
        }
    }

    private onCheckSessionChanged() {
        console.log('onCheckSessionChanged');
        this.oidcSecurityCommon.store('CheckSessionChanged', true);
        this.checkSessionChanged = true;
    }

    private runGetSigningKeys() {
        this.getSigningKeys()
            .subscribe(
            jwtKeys => this.jwtKeys = jwtKeys,
            error => this.errorMessage = <any>error);
    }

    private getSigningKeys(): Observable<JwtKeys> {
        return this.http.get(this.authConfiguration.jwks_url)
            .map(this.extractData)
            .catch(this.handleErrorGetSigningKeys);
    }

    private extractData(res: Response) {
        let body = res.json();
        return body;
    }

    private handleErrorGetSigningKeys(error: Response | any) {
        // In a real world app, you might use a remote logging infrastructure
        let errMsg: string;
        if (error instanceof Response) {
            const body = error.json() || '';
            const err = body.error || JSON.stringify(body);
            errMsg = `${error.status} - ${error.statusText || ''} ${err}`;
        } else {
            errMsg = error.message ? error.message : error.toString();
        }
        console.error(errMsg);
        return Observable.throw(errMsg);
    }


    private setHeaders() {
        this.headers = new Headers();
        this.headers.append('Content-Type', 'application/json');
        this.headers.append('Accept', 'application/json');

        let token = this.getToken();

        if (token !== '') {
            this.headers.append('Authorization', 'Bearer ' + token);
        }
    }

    private runTokenValidatation() {
        let source = Observable.timer(3000, 3000)
            .timeInterval()
            .pluck('interval')
            .take(10000);

        let subscription = source.subscribe(() => {
            if (this.isAuthorized) {
                if (this.oidcSecurityValidation.isTokenExpired(this.oidcSecurityCommon.retrieve('authorizationDataIdToken'))) {
                    console.log('IsAuthorized: isTokenExpired');

                    if (this.authConfiguration.silent_renew) {
                        this.refreshSession();
                    } else {
                        this.resetAuthorizationData();
                    }
                }
            }
        },
        function (err: any) {
            console.log('Error: ' + err);
        },
        function () {
            console.log('Completed');
        });
    }
}
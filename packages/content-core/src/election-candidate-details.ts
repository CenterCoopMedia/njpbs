/** Verified November 2, 2026 against the nj-decides stable-ID roster and live
 * NJ Spotlight 2026 guides. These render-time links add no stored block fields.
 * Update only after checking the guide names the candidate. */
export interface ElectionCandidateDetails {
  profileUrl: string;
  campaignWebsite?: string;
  incumbent: boolean;
}
export const ELECTION_CANDIDATE_DETAILS: Readonly<Record<string, ElectionCandidateDetails>> = {
  "us-senate-cory-booker": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-u-s-senate/",
    "campaignWebsite": "https://corybooker.com/",
    "incumbent": true
  },
  "us-senate-justin-murphy": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-u-s-senate/",
    "campaignWebsite": "https://jerseyjustin4senate.org/",
    "incumbent": false
  },
  "us-senate-veronica-fernandez": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-u-s-senate/",
    "campaignWebsite": "https://veronicaforsenate.com/",
    "incumbent": false
  },
  "us-senate-joanne-kuniansky": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-u-s-senate/",
    "incumbent": false
  },
  "us-house-01-donald-norcross": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-election-profile-1st-congressional-district/",
    "campaignWebsite": "https://www.donaldnorcrossforcongress.com/",
    "incumbent": true
  },
  "us-house-01-damon-galdo": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-election-profile-1st-congressional-district/",
    "campaignWebsite": "https://votedamongaldo.com/",
    "incumbent": false
  },
  "us-house-02-jeff-van-drew": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-election-profile-2nd-congressional-district/",
    "campaignWebsite": "https://vandrewforcongress.com/",
    "incumbent": true
  },
  "us-house-02-zack-mullock": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-election-profile-2nd-congressional-district/",
    "campaignWebsite": "https://mullockforcongress.com/",
    "incumbent": false
  },
  "us-house-02-ramon-mora-jr": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-election-profile-2nd-congressional-district/",
    "campaignWebsite": "https://www.southjerseygrit.com/",
    "incumbent": false
  },
  "us-house-03-herb-conaway": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-3rd-congressional-district/",
    "campaignWebsite": "https://www.herbforcongress.com/",
    "incumbent": true
  },
  "us-house-03-michael-p-mcguire": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-3rd-congressional-district/",
    "campaignWebsite": "https://michaelmcguireforcongress.com/",
    "incumbent": false
  },
  "us-house-03-ryan-michael-kelly": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-3rd-congressional-district/",
    "campaignWebsite": "https://www.kellyfornj03.com/",
    "incumbent": false
  },
  "us-house-03-steven-welzer": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-3rd-congressional-district/",
    "campaignWebsite": "https://www.welzerforcongress.org/",
    "incumbent": false
  },
  "us-house-04-christopher-h-smith": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-4th-congressional-district/",
    "campaignWebsite": "https://smith4nj.com/",
    "incumbent": true
  },
  "us-house-04-rachel-peace": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-4th-congressional-district/",
    "campaignWebsite": "https://www.peace4shore.com/",
    "incumbent": false
  },
  "us-house-05-josh-gottheimer": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/primary-election-profile-5th-congressional-district/",
    "campaignWebsite": "https://josh4jersey.com/",
    "incumbent": true
  },
  "us-house-05-sean-kirrane": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/primary-election-profile-5th-congressional-district/",
    "campaignWebsite": "https://www.seankirrane.com/",
    "incumbent": false
  },
  "us-house-05-adam-rueda": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/primary-election-profile-5th-congressional-district/",
    "campaignWebsite": "https://adamruedafornj5.com/",
    "incumbent": false
  },
  "us-house-06-frank-pallone-jr": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-6th-congressional-district/",
    "campaignWebsite": "https://www.pallonefornewjersey.com/",
    "incumbent": true
  },
  "us-house-06-hillary-herzig": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-6th-congressional-district/",
    "campaignWebsite": "https://www.herzigforcongress.com/",
    "incumbent": false
  },
  "us-house-07-thomas-h-kean-jr": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-7th-congressional-district/",
    "campaignWebsite": "https://tomkean.com/",
    "incumbent": true
  },
  "us-house-07-rebecca-bennett": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-7th-congressional-district/",
    "campaignWebsite": "https://rebeccabennettforcongress.com/",
    "incumbent": false
  },
  "us-house-07-seamus-patrick-otoole": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-7th-congressional-district/",
    "incumbent": false
  },
  "us-house-08-rob-menendez": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-8th-congressional-district/",
    "campaignWebsite": "https://www.robmenendez.com/",
    "incumbent": true
  },
  "us-house-08-aristotle-eliopoulos": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-8th-congressional-district/",
    "incumbent": false
  },
  "us-house-08-craig-honts": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-8th-congressional-district/",
    "incumbent": false
  },
  "us-house-08-dashone-hughey": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-8th-congressional-district/",
    "campaignWebsite": "https://www.votedashonehughey.com/",
    "incumbent": false
  },
  "us-house-09-nelida-pou": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-9th-congressional-district/",
    "campaignWebsite": "https://www.nelliepoufornewjersey.com/",
    "incumbent": true
  },
  "us-house-09-rosie-pino": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-9th-congressional-district/",
    "campaignWebsite": "https://rosiepinofornj.com/",
    "incumbent": false
  },
  "us-house-09-terrisa-bukovinac": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-9th-congressional-district/",
    "campaignWebsite": "https://terrisa2026.com/",
    "incumbent": false
  },
  "us-house-10-lamonica-r-mciver": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-10th-congressional-district/",
    "campaignWebsite": "https://www.lamonicaforcongress.com/",
    "incumbent": true
  },
  "us-house-10-carmen-bucco": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-10th-congressional-district/",
    "campaignWebsite": "https://carmenbucco.com/",
    "incumbent": false
  },
  "us-house-11-analilia-mejia": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-11th-congressional-district/",
    "campaignWebsite": "https://www.analiliafornj.com/",
    "incumbent": true
  },
  "us-house-11-joe-hathaway": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-11th-congressional-district/",
    "campaignWebsite": "https://www.joehathawayforcongress.com/",
    "incumbent": false
  },
  "us-house-11-alan-b-bond": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-11th-congressional-district/",
    "campaignWebsite": "https://hopefortomorrownj.org/",
    "incumbent": false
  },
  "us-house-12-adam-hamawy": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-12th-congressional-district/",
    "campaignWebsite": "https://hamawyfornj.com/",
    "incumbent": false
  },
  "us-house-12-gregg-mele": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-12th-congressional-district/",
    "incumbent": false
  },
  "us-house-12-andres-jinete": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-12th-congressional-district/",
    "campaignWebsite": "https://andresjinete.org/",
    "incumbent": false
  },
  "us-house-12-winston-jordan": {
    "profileUrl": "https://www.njspotlightnews.org/special-report/2026-primary-12th-congressional-district/",
    "campaignWebsite": "https://www.winstonforcongress.com/",
    "incumbent": false
  }
};

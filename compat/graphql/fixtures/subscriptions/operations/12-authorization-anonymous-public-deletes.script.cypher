// The DELETED rule with requireAuthentication: false lets anonymous subscribers see public reviews.
MATCH (r:Review) DELETE r;

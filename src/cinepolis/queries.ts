/**
 * GraphQL documents used by the public cinepolis.com web app (captured 2026-10-19).
 * Kept verbatim so requests look exactly like the site's own.
 */

export interface Operation {
  path: string;
  operationName: string;
  query: string;
}

export const MOVIES_LIST: Operation = {
  path: "/v2/billboards/graphql",
  operationName: "Movies",
  query: "query Movies($countryId: String!, $category: String, $cinemas: String, $after: String, $limit: Int, $isAbsoluteMediaPath: Boolean) {\n  movies(\n    countryId: $countryId\n    category: $category\n    cinemas: $cinemas\n    after: $after\n    limit: $limit\n    isAbsoluteMediaPath: $isAbsoluteMediaPath\n  ) {\n    pageInfo {\n      startCursor\n      endCursor\n      hasNextPage\n      hasPreviousPage\n      __typename\n    }\n    totalCount\n    edges {\n      cursor\n      node {\n        id\n        type\n        countryId\n        name\n        originalName\n        distributor\n        rating\n        ratingDescription\n        position\n        genre\n        synopsis\n        length\n        availableForSale\n        alerts {\n          title\n          message\n          __typename\n        }\n        releaseDate\n        languages\n        formats\n        tags {\n          name\n          resource\n          __typename\n        }\n        media {\n          resource\n          type\n          code\n          sizes {\n            large\n            medium\n            small\n            __typename\n          }\n          __typename\n        }\n        cities\n        cinemas\n        categories\n        experiences {\n          icon\n          name\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}",
};

export const BILLBOARD_BY_CINEMA: Operation = {
  path: "/v2/billboards/graphql",
  operationName: "Billboard",
  query: "query Billboard($countryId: String!, $cinemaId: String!, $timezone: String!, $isAbsoluteExperiencePath: Boolean) {\n  billboardByCinema(\n    countryId: $countryId\n    cinemaId: $cinemaId\n    timezone: $timezone\n    isAbsoluteExperiencePath: $isAbsoluteExperiencePath\n  ) {\n    dates\n    schedules {\n      cinemaId\n      cityId\n      movieId\n      dates {\n        date\n        languages {\n          language\n          displayLanguage\n          showtimes {\n            format {\n              icon\n              name\n              __typename\n            }\n            sessionId\n            datetime\n            screen\n            experience {\n              icon\n              name\n              __typename\n            }\n            movieVistaId\n            cinemaVistaId\n            alerts {\n              section\n              title\n              message\n              __typename\n            }\n            availability\n            isAllocatedSeating\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}",
};

export const CINEMAS: Operation = {
  path: "/shared-services/locations/graphql",
  operationName: "Cinemas",
  query: "query Cinemas($country_id: String!, $cinemas: String!) {\n  cinemasById(country_id: $country_id, cinemas: $cinemas) {\n    edges {\n      cursor\n      node {\n        id\n        lat\n        lng\n        name\n        type\n        cityId\n        vistaId\n        regionId\n        timezone\n        businessType\n        settings {\n          requireContiguousSeating\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}",
};

export const MOVIE_DETAIL: Operation = {
  path: "/v2/billboards/graphql",
  operationName: "Movies",
  query: "query Movies($countryId: String!, $id: String!, $isAbsoluteMediaPath: Boolean) {\n  movie(countryId: $countryId, id: $id, isAbsoluteMediaPath: $isAbsoluteMediaPath) {\n    id\n    type\n    countryId\n    name\n    originalName\n    distributor\n    rating\n    position\n    ratingDescription\n    genre\n    synopsis\n    length\n    availableForSale\n    alerts {\n      title\n      message\n      __typename\n    }\n    releaseDate\n    tags {\n      name\n      resource\n      __typename\n    }\n    media {\n      resource\n      type\n      code\n      sizes {\n        large\n        medium\n        small\n        __typename\n      }\n      __typename\n    }\n    cities\n    cinemas\n    categories\n    experiences {\n      icon\n      name\n      __typename\n    }\n    cast {\n      actors {\n        name\n        description\n        nameInMovie\n        moviesTotal\n        image {\n          resource\n          sizes {\n            large\n            medium\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      directors {\n        name\n        description\n        nameInMovie\n        moviesTotal\n        image {\n          resource\n          sizes {\n            large\n            medium\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      producers {\n        name\n        description\n        nameInMovie\n        moviesTotal\n        image {\n          resource\n          sizes {\n            large\n            medium\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}",
};

export const BILLBOARD_BY_MOVIE: Operation = {
  path: "/v2/billboards/graphql",
  operationName: "Billboard",
  query: "query Billboard($countryId: String!, $movieId: String!, $cinemas: String!, $timezone: String, $isAbsoluteExperiencePath: Boolean) {\n  billboard(\n    countryId: $countryId\n    movieId: $movieId\n    cinemas: $cinemas\n    timezone: $timezone\n    isAbsoluteExperiencePath: $isAbsoluteExperiencePath\n  ) {\n    dates\n    schedules {\n      cinemaId\n      cityId\n      movieId\n      dates {\n        date\n        languages {\n          language\n          displayLanguage\n          showtimes {\n            format {\n              icon\n              name\n              __typename\n            }\n            sessionId\n            datetime\n            screen\n            experience {\n              icon\n              name\n              __typename\n            }\n            movieVistaId\n            cinemaVistaId\n            alerts {\n              section\n              title\n              message\n              __typename\n            }\n            availability\n            isAllocatedSeating\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}",
};

export const SEATS: Operation = {
  path: "/v1/ticket/graphql",
  operationName: "Seats",
  query: "query Seats($countryId: String!, $sessionId: String!, $cinemaVistaId: String!, $userSessionId: String, $experience: String) {\n  seats(\n    countryId: $countryId\n    sessionId: $sessionId\n    cinemaVistaId: $cinemaVistaId\n    userSessionId: $userSessionId\n    experience: $experience\n  ) {\n    maxQuantity\n    seatLayoutData {\n      areas {\n        rowCount\n        columnCount\n        description\n        areaCategoryCode\n        rows {\n          physicalName\n          seats {\n            id\n            status\n            originalStatus\n            seatStyle\n            position {\n              columnIndex\n              rowIndex\n              areaNumber\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      areaCategories {\n        areaCategoryCode\n        seatType\n        capacity\n        name\n        description\n        image\n        hopk\n        selectedSeats {\n          areaNumber\n          rowIndex\n          columnIndex\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}",
};

export const TICKETS: Operation = {
  path: "/v1/ticket/graphql",
  operationName: "Tickets",
  query: "query Tickets($countryId: String!, $sessionId: String!, $cinemaVistaId: String!, $userSessionId: String, $includeAllTickets: Boolean) {\n  tickets(\n    countryId: $countryId\n    cinemaVistaId: $cinemaVistaId\n    sessionId: $sessionId\n    userSessionId: $userSessionId\n    includeAllTickets: $includeAllTickets\n  ) {\n    areaCategoryCode\n    tickets {\n      id\n      ticketTypeCode\n      description\n      ticketDescription\n      priceInCents\n      bookingFee\n      taxInCents\n      displaySequence\n      quantityAvailablePerOrder\n      type\n      isPackageTicket\n      feeTaxes {\n        cgst\n        sgst\n        cgstRate\n        sgstRate\n        __typename\n      }\n      billingInfo {\n        gstin\n        hsn\n        sac\n        fssai\n        __typename\n      }\n      packageContent {\n        tickets {\n          description\n          quantity\n          __typename\n        }\n        concessions {\n          isConfigurable\n          itemId\n          displayName\n          description\n          charge\n          isInventoryProduct\n          quantity\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}",
};

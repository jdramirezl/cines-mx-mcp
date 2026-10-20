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

// --- Member / order operations (captured 2026-10-19; CancelOrder/ExtendOrder/OrderDispatcher from the site JS) ---

export const USER_SESSION_ID: Operation = {
  path: "/v1/members/graphql",
  operationName: "UserSessionId",
  query: "query UserSessionId($cinemaId: String!, $pass: String, $pin: String, $userSessionId: String) {\n  user_session_id(\n    cinemaId: $cinemaId\n    pass: $pass\n    pin: $pin\n    userSessionId: $userSessionId\n  )\n}",
};

export const PROFILE: Operation = {
  path: "/v1/members/graphql",
  operationName: "Profile",
  query: "query Profile($countryId: String!, $tcc: String) {\n  member(countryId: $countryId, tcc: $tcc) {\n    nationalId\n    tcc\n    name\n    memberId\n    pointsBalance\n    visitBalance\n    nextVisitLabel\n    nextLevelVisitMessage\n    levelName\n    nextLevelName\n    visitPeriod\n    profileImage\n    isOpenBank\n    pointsExpiryDate\n    benefitPercentage\n    loyaltyProgram\n    benefitMessages {\n      text\n      type\n      __typename\n    }\n    __typename\n  }\n  benefits(countryId: $countryId) {\n    key\n    name\n    caption\n    imageUrl\n    status\n    __typename\n  }\n  openbank_benefits(countryId: $countryId) {\n    key\n    name\n    caption\n    imageUrl\n    status\n    __typename\n  }\n  additional_information(countryId: $countryId) {\n    name\n    caption\n    imageUrl\n    url\n    __typename\n  }\n}",
};

export const ORDER: Operation = {
  path: "/v1/ticket/graphql",
  operationName: "Order",
  query: "mutation Order($orderData: OrdersInput!) {\n  order(orderData: $orderData) {\n    order {\n      cinemaVistaId\n      orderUserId\n      tickets {\n        orderId\n        __typename\n      }\n      total\n      charges\n      subtotal\n      __typename\n    }\n    __typename\n  }\n}",
};

export const CANCEL_ORDER: Operation = {
  path: "/v1/carts/graphql",
  operationName: "CancelOrder",
  query: "mutation CancelOrder($input: CancelOrderModel) {\n    CancelOrder(cancel_order: $input) {\n      cancelOrderResult {\n        extended_result_code\n        order_not_found\n        result\n        error_description\n      }\n    }\n  }",
};

export const EXTEND_ORDER: Operation = {
  path: "/v1/carts/graphql",
  operationName: "ExtendOrder",
  query: "mutation ExtendOrder($user_session_id: String) {\n    ExtendOrder(extend_order: { user_session_id: $user_session_id }) {\n      extendOrderResult {\n        status\n      }\n    }\n  }",
};

export const PAYPAL_WALLET_CHECKOUT: Operation = {
  path: "/v1/purchase/graphql",
  operationName: "paypalWalletCheckout",
  query: "mutation paypalWalletCheckout($country_id: String!, $order_session_id: String!, $user_session_id: String!, $email: String!, $first_name: String!, $last_name: String!, $format: String!, $isPartial: Boolean!) {\n  paypalWalletCheckout(\n    paypal_checkout: {country_id: $country_id, order_session_id: $order_session_id, user_session_id: $user_session_id, customer: {email: $email, first_name: $first_name, last_name: $last_name}, movie: {format: $format}, is_partial: $isPartial}\n  ) {\n    orderToken {\n      order_token\n      __typename\n    }\n    __typename\n  }\n}",
};

export const ORDER_DISPATCHER: Operation = {
  path: "/v1/purchase/graphql",
  operationName: "OrderDispatcher",
  query: "query OrderDispatcher($orderSessionId: String!, $countryId: String!) {\n        orderDispatcher(\n            orderSessionId: $orderSessionId\n            countryId: $countryId\n        ) {\n            order_session_id\n            country_id\n            status\n            tcc\n            purchase_datetime\n            transaction_datetime\n            booking_id\n            booking_time\n            transaction_number\n            country_id_cinema_id\n            transaction {\n                booking_id\n                trans_number\n                booking_number\n                transact_type\n            }\n            cinema {\n                type\n                id\n                name\n                vista_id\n                business_type\n            }\n            payment {\n                payment_id\n                payment_method\n                payment_info {\n                    last4Digits\n                    cardType\n                }\n            }\n            foods {\n                order_id\n                delivery_line\n                provider_name\n                concessions {\n                    added_points\n                    comments\n                    concession\n                    description\n                    ingredients_name\n                    modifiers\n                    price\n                    product_name\n                    promotion\n                    quantity\n                    image\n                    recipe_items {\n                        product\n                        quantity\n                        description\n                        product_description\n                        product_name\n                        modifiers\n                        ingredients_name\n                    }\n                }\n            }\n            tickets {\n                provider_name\n                order_id\n                added_points\n                movie {\n                    type\n                    duration\n                    image\n                    synopsis\n                    rating\n                    name\n                }\n                schedule {\n                    session_id\n                    screen_number\n                    datetime\n                    language\n                    experience {\n                        name \n                    }\n                }\n                seats {\n                    number\n                    capacity\n                    promotion\n                    tickets_options {\n                        description\n                        selected\n                        price\n                        booking_fee\n                        ticket_type_code\n                        package_content {\n                            concessions {\n                                description\n                                display_name\n                                charge\n                                quantity\n                            }\n                        }\n                    }\n                }\n            }\n            bill_url{\n                url\n            },\n            amount {\n                subtotal\n                charges\n                points\n                total\n            }\n        }\n    }",
};

// --- Card payment (captured 2026-10-20, purchase with a saved card; documents verbatim) ---

export const USER_SESSION_DEUNA: Operation = {
  path: "/v1/payment-wallet/graphql",
  operationName: "UserSessionDeuna",
  query: "query UserSessionDeuna($first_name: String!, $last_name: String!) {\n  userSessionDeuna(first_name: $first_name, last_name: $last_name) {\n    user_token\n    __typename\n  }\n}",
};

export const PAYMENT_METHODS: Operation = {
  path: "/v1/payment-method/graphql",
  operationName: "payment_methods",
  query: "query payment_methods($orderSessionId: String!, $countryId: String!) {\n  payment_methods(orderSessionId: $orderSessionId, countryId: $countryId) {\n    name\n    order\n    key\n    enabled\n    settings {\n      profile {\n        org_id\n        merch\n        provider\n        __typename\n      }\n      iframe_url\n      icon {\n        url\n        __typename\n      }\n      public_key\n      merchant\n      org_id\n      env\n      use_wallet\n      otp\n      otp_flow\n      points_to_use\n      available_points\n      total_redeemed\n      placeholder\n      __typename\n    }\n    __typename\n  }\n}",
};

/** The charge itself. Called exactly once per purchase attempt; never retried. */
export const HANDLER_COMPLETE: Operation = {
  path: "/v1/purchase/graphql",
  operationName: "handlerComplete",
  query: "mutation handlerComplete($input: DispacherComplete) {\n  handlerComplete(dispacher_complete: $input) {\n    bookingInfo {\n      booking_id\n      booking_number\n      trans_number\n      __typename\n    }\n    __typename\n  }\n}",
};
